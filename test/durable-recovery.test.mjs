import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDurableInbox } from "../src/durable-inbox.mjs";
import { createRecoveryWorker } from "../src/recovery-worker.mjs";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-durable-"));
let nowMs = Date.parse("2026-07-29T10:00:00.000Z");
const inbox = createDurableInbox({
  rootDir: join(tmp, "inbox"),
  now: () => nowMs,
});

await inbox.enqueue({
  type: "comment",
  external_id: "comment-retry",
  received_at: new Date(nowMs).toISOString(),
  payload: { commentId: "comment-retry" },
});

let attempts = 0;
const worker = createRecoveryWorker({
  inbox,
  statusFile: join(tmp, "recovery.json"),
  now: () => nowMs,
  retryBaseMs: 1_000,
  maxAttempts: 3,
  processEvent: async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("temporary provider failure");
      error.code = "PROVIDER_NETWORK_ERROR";
      error.metaIsTransient = true;
      throw error;
    }
    return [{ commentId: "comment-retry", keyword: "GUIDE", status: "sent" }];
  },
});

const first = await worker.runDue();
assert.equal(first.retried, 1);
assert.equal((await inbox.summary()).pending_count, 1);

nowMs += 1_001;
const second = await worker.runDue();
assert.equal(second.completed, 1);
assert.equal((await inbox.summary()).completed_count, 1);

await inbox.enqueue({
  type: "message",
  external_id: "message-interrupted",
  received_at: new Date(nowMs).toISOString(),
  payload: { messageId: "message-interrupted" },
});
await inbox.claimNext();
assert.equal((await inbox.summary()).processing_count, 1);
assert.equal(await inbox.recoverInterrupted(), 1);
assert.equal((await inbox.summary()).pending_count, 1);

await inbox.enqueue({
  type: "comment",
  external_id: "comment-permanent",
  received_at: new Date(nowMs).toISOString(),
  payload: { commentId: "comment-permanent" },
});
const permanentWorker = createRecoveryWorker({
  inbox,
  statusFile: join(tmp, "permanent-recovery.json"),
  now: () => nowMs,
  processEvent: async (event) => {
    if (event.external_id === "comment-permanent") {
      const error = new Error("recipient cannot receive this private reply");
      error.status = 403;
      error.metaCode = 200;
      error.metaSubcode = 2534066;
      throw error;
    }
    return [{ messageId: event.external_id, status: "ignored" }];
  },
});
const permanent = await permanentWorker.runDue({ limit: 10 });
assert.equal(permanent.dead_lettered, 1);
const [deadLetter] = await inbox.listDeadLetters();
assert.equal(deadLetter.external_id, "comment-permanent");
assert.equal(deadLetter.error_provider_subcode, 2534066);
assert.equal(await inbox.resolveDeadLetter(deadLetter.event_key, "provider confirmed permanent"), true);
assert.equal((await inbox.summary()).dead_letter_count, 0);
assert.equal((await inbox.summary()).resolved_count, 1);

console.log("durable-recovery.test.mjs passed");
