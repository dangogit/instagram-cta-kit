import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDurableInbox } from "../src/durable-inbox.mjs";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-hookmyapp-"));
await mkdir(join(tmp, "state"), { recursive: true });
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [{
    keyword: "GUIDE",
    campaign_id: "hookmyapp-guide",
    guide_url: "https://example.com/guide",
    reply_text: "Guide: https://example.com/guide",
    public_reply_text: "Sent",
  }],
}));

process.env.DEFAULT_LOCALE = "en";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.CTA_PROVIDER = "hookmyapp";
process.env.VERIFY_TOKEN = "hookmyapp-verify";
process.env.WEBHOOK_HMAC_SECRET = randomBytes(32).toString("hex");
process.env.INSTAGRAM_ACCOUNT_ID = "account-1";
process.env.INSTAGRAM_ACCESS_TOKEN = "hookmyapp-token";
process.env.INSTAGRAM_GRAPH_API_URL = "https://gateway.hookmyapp.com/meta/v25.0";
process.env.HOOKMYAPP_CHANNEL_ID = "ch_test";
process.env.CTA_ADMIN_TOKEN = "admin-token";
process.env.CTA_ATTRIBUTION_SECRET = "attribution-secret";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = join(tmp, "state", "events.jsonl");
process.env.DRY_RUN = "0";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  if (parsed.hostname === "gateway.hookmyapp.com") {
    return Response.json({ id: options.method === "POST" ? "hookmyapp-send" : "account-1" });
  }
  return nativeFetch(url, options);
};

const { createServer, runRecoveryOnce } = await import("../src/server.mjs");
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

const probe = await fetch(`${base}/webhook`, {
  headers: {
    "X-HookMyApp-Probe": "webhook-verification",
    "User-Agent": "HookMyApp-Webhook-Verifier",
  },
});
assert.equal(probe.status, 200);
assert.equal(await probe.text(), "hookmyapp-verify");

const payload = {
  object: "instagram",
  entry: [{
    id: "account-1",
    changes: [{
      field: "comments",
      value: {
        id: "hookmyapp-comment",
        text: "GUIDE",
        from: { id: "person-1" },
        media: { id: "media-1" },
      },
    }],
  }],
};
const body = JSON.stringify(payload);
const signature = createHmac("sha256", process.env.WEBHOOK_HMAC_SECRET).update(body).digest("hex");
const accepted = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-HookMyApp-Signature-256": `sha256=${signature}`,
  },
  body,
});
assert.equal(accepted.status, 200);
const acknowledgement = await accepted.json();
assert.equal(acknowledgement.queued[0].duplicate, false);
const recovered = await runRecoveryOnce();
assert.equal(recovered.results[0].keyword, "GUIDE");
assert.equal(recovered.results[0].status, "sent");

const echoPayload = {
  object: "instagram",
  entry: [{
    id: "account-1",
    messaging: [{
      sender: { id: "account-1" },
      recipient: { id: "person-1" },
      message: { mid: "outbound-echo", text: "Sent", is_echo: true },
    }],
  }],
};
const echoBody = JSON.stringify(echoPayload);
const echoSignature = createHmac("sha256", process.env.WEBHOOK_HMAC_SECRET)
  .update(echoBody)
  .digest("hex");
const echo = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "X-HookMyApp-Signature-256": `sha256=${echoSignature}` },
  body: echoBody,
});
assert.deepEqual((await echo.json()).queued, []);

const rejected = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "X-HookMyApp-Signature-256": `sha256=${"0".repeat(64)}` },
  body,
});
assert.equal(rejected.status, 403);

const health = await fetch(`${base}/health`);
const healthJson = await health.json();
assert.equal(healthJson.provider, "hookmyapp");
assert.equal(healthJson.queue.pending_count, 0);
assert.equal(healthJson.queue.completed_count, 1);

const testInbox = createDurableInbox({ rootDir: join(tmp, "state", "inbox") });
await testInbox.enqueue({
  type: "message",
  external_id: "interrupted-message",
  received_at: new Date().toISOString(),
  payload: {
    igUserId: "account-1",
    senderId: "person-2",
    messageId: "interrupted-message",
    text: "hello",
    payload: "",
  },
});
await testInbox.claimNext();
const interruptedHealth = await fetch(`${base}/health`);
assert.equal(interruptedHealth.status, 503);
assert.ok((await interruptedHealth.json()).issues.includes("processing_event_interrupted"));

const recoveredResponse = await fetch(`${base}/admin/recover`, {
  method: "POST",
  headers: { Authorization: "Bearer admin-token" },
});
assert.equal(recoveredResponse.status, 200);
const recoveredBody = await recoveredResponse.json();
assert.equal(recoveredBody.recovered_interrupted, 1);
assert.equal(recoveredBody.result.completed, 1);

const healthyAgain = await fetch(`${base}/health`);
assert.equal(healthyAgain.status, 200);
assert.equal((await healthyAgain.json()).queue.processing_count, 0);

server.close();
await once(server, "close");
console.log("hookmyapp.test.mjs passed");
