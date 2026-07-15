import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-public-readiness-"));
const stateFile = join(tmp, "state", "events.jsonl");
await mkdir(join(tmp, "state"), { recursive: true });
await writeFile(stateFile, "");
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "GUIDE",
      campaign_id: "guide-one",
      guide_url: "https://one.example/guide",
      reply_text: "Guide one: https://one.example/guide",
      intro_text: "Want guide one?",
      public_reply_text: "Sent",
      media_ids: ["media-1"],
    },
    {
      keyword: "GUIDE",
      campaign_id: "guide-two",
      guide_url: "https://two.example/guide",
      reply_text: "Guide two: https://two.example/guide",
      intro_text: "Want guide two?",
      public_reply_text: "Sent",
      media_ids: ["media-2"],
    },
  ],
}));

process.env.DEFAULT_LOCALE = "en";
process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.VERIFY_TOKEN = "public-readiness-verify-token";
process.env.META_APP_SECRET = "public-readiness-app-secret";
process.env.IG_USER_ID = "account-1";
process.env.IG_ACCESS_TOKEN = "dry-run-token";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.WEBHOOK_LOG_FILE = join(tmp, "state", "webhooks.jsonl");
process.env.CTA_ATTRIBUTION_SECRET = "public-readiness-attribution-secret";
process.env.DRY_RUN = "1";
process.env.POLL_ENABLED = "0";
process.env.MAX_WEBHOOK_BODY_BYTES = "512";

const { createServer, processComments, processMessages } = await import("../src/server.mjs");

function message(id, payload, text = "") {
  return {
    igUserId: "account-1",
    senderId: "person-1",
    messageId: id,
    text,
    payload,
    raw: {},
  };
}

const first = await processMessages([
  message("message-1", "CTA_WANTS_GUIDE|GUIDE|media-2", "Yes, send it"),
]);
assert.equal(first[0].status, "sent");

const second = await processMessages([
  message("message-2", "CTA_WANTS_GUIDE|GUIDE|media-2", "Yes, send it"),
]);
assert.equal(second[0].status, "skipped_guide_delivered");

await processMessages([
  message("message-ignored", "", "private message that must not be logged"),
]);

let events = (await readFile(stateFile, "utf8")).trim().split("\n").map(JSON.parse);
const delivered = events.find((event) => event.message_id === "message-1");
assert.match(delivered.meta.body.message.text, /two\.example/);
assert.doesNotMatch(delivered.meta.body.message.text, /one\.example/);
const ignored = events.find((event) => event.message_id === "message-ignored");
assert.equal(Object.hasOwn(ignored, "text"), false);

await processComments([{
  igUserId: "account-1",
  commentId: "comment-existing-follower",
  mediaId: "media-1",
  text: "GUIDE",
  fromId: "person-existing-follower",
  followerState: true,
  raw: {},
}]);
const existingFollower = await processMessages([{
  igUserId: "account-1",
  senderId: "person-existing-follower",
  messageId: "message-existing-follower",
  text: "Yes, send it",
  payload: "CTA_WANTS_GUIDE|GUIDE|media-1",
  raw: {},
}]);
assert.equal(existingFollower[0].status, "sent");

await processComments([{
  igUserId: "account-1",
  commentId: "comment-existing-follower-text",
  mediaId: "media-1",
  text: "GUIDE",
  fromId: "person-existing-follower-text",
  followerState: true,
  raw: {},
}]);
const existingFollowerText = await processMessages([{
  igUserId: "account-1",
  senderId: "person-existing-follower-text",
  messageId: "message-existing-follower-text",
  text: "yes",
  payload: "",
  raw: {},
}]);
assert.equal(existingFollowerText[0].status, "sent");

const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

const tooLarge = await fetch(`${base}/webhook`, {
  method: "POST",
  body: "x".repeat(513),
});
assert.equal(tooLarge.status, 413);

const payload = Buffer.from(JSON.stringify({
  object: "instagram",
  entry: [{
    id: "account-1",
    changes: [{
      field: "comments",
      value: {
        comment_id: "comment-concurrent",
        media_id: "media-1",
        text: "GUIDE",
        from: { id: "person-concurrent" },
      },
    }],
  }],
}));
const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET).update(payload).digest("hex")}`;
const sendWebhook = () => fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": signature,
  },
  body: payload,
}).then((response) => response.json());

const concurrent = await Promise.all([sendWebhook(), sendWebhook()]);
const statuses = concurrent.flatMap((result) => result.comments.map((item) => item.status)).sort();
assert.deepEqual(statuses, ["sent", "skipped_duplicate"]);

events = (await readFile(stateFile, "utf8")).trim().split("\n").map(JSON.parse);
assert.equal(events.some((event) => event.text === "private message that must not be logged"), false);

await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("public-readiness.test.mjs passed");
