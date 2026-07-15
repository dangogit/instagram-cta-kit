import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-retry-"));
const stateFile = join(tmp, "state", "events.jsonl");
await mkdir(join(tmp, "state"), { recursive: true });
await writeFile(stateFile, "");
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [{
    keyword: "GUIDE",
    campaign_id: "retry-guide",
    guide_url: "https://example.com/guide",
    reply_text: "Guide: https://example.com/guide",
    public_reply_text: "Sent",
  }],
}));

process.env.DEFAULT_LOCALE = "en";
process.env.VERIFY_TOKEN = "retry-verify-token";
process.env.META_APP_SECRET = "retry-app-secret";
process.env.IG_USER_ID = "account-1";
process.env.IG_ACCESS_TOKEN = "retry-token";
process.env.GRAPH_BASE_URL = "https://meta.test/v25.0";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.WEBHOOK_LOG_FILE = join(tmp, "state", "webhooks.jsonl");
process.env.CTA_ATTRIBUTION_SECRET = "retry-attribution-secret";
process.env.DRY_RUN = "0";
process.env.POLL_ENABLED = "0";
process.env.META_REQUEST_TIMEOUT_MS = "1000";

let shouldFail = true;
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  if (shouldFail) return Response.json({ error: { message: "temporary" } }, { status: 500 });
  return Response.json({ recipient_id: "person-1", message_id: "sent-message" });
};

const { processMessages } = await import("../src/server.mjs");
const inbound = {
  igUserId: "account-1",
  senderId: "person-1",
  messageId: "incoming-message",
  text: "Yes, send it",
  payload: "CTA_WANTS_GUIDE|GUIDE|direct-dm:GUIDE",
  raw: {},
};

const failed = await processMessages([inbound]);
assert.equal(failed[0].status, "error");
assert.equal(calls, 3);

shouldFail = false;
const retried = await processMessages([inbound]);
assert.equal(retried[0].status, "sent");
assert.equal(calls, 4);

console.log("retry.test.mjs passed");

