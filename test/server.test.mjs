import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "AGENT",
      campaign_id: "test-agent-campaign",
      guide_url: "https://example.com/guides/agent",
      reply_text: "agent guide\nhttps://example.com/guides/agent",
      requires_follow: true,
      non_follower_text: "follow first",
      unknown_follower_text: "agent guide\nfollow ask",
      public_reply_text: "אצלך בפרטי 🔥",
    },
    {
      keyword: "AGENTIC",
      reply_text: "agentic guide",
      requires_follow: true,
      non_follower_text: "follow first",
      unknown_follower_text: "agentic guide\nfollow ask",
      public_reply_text: "אצלך בפרטי 🔥",
    },
    {
      keyword: "DUO",
      aliases: ["DOU"],
      reply_text: "duo guide",
      requires_follow: true,
      non_follower_text: "follow first duo",
      public_reply_text: "אצלך בפרטי 🔥",
    },
  ],
}));

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = randomBytes(32).toString("hex");
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.WEBHOOK_LOG_FILE = join(tmp, "state", "webhooks.jsonl");
process.env.DRY_RUN = "1";
process.env.CTA_ATTRIBUTION_SECRET = "test-attribution-secret";

await writeFile(stateFile, [
  {
    status: "dm_sent",
    keyword: "AGENT",
    comment_id: "comment-public-retry",
    media_id: "media-1",
    from_id: "user-retry",
    follower_state: true,
    at: new Date().toISOString(),
  },
  {
    status: "sent",
    keyword: "AGENT",
    comment_id: "comment-pending-follow",
    media_id: "media-1",
    from_id: "user-followup",
    follower_state: false,
    at: new Date().toISOString(),
  },
  {
    status: "dm_error",
    keyword: "AGENT",
    comment_id: "comment-health-error",
    media_id: "media-1",
    from_id: "user-health-error",
    follower_state: null,
    error: "boom",
    at: new Date().toISOString(),
  },
].map((event) => JSON.stringify(event)).join("\n") + "\n");

const { createServer, runRecoveryOnce } = await import("../src/server.mjs");
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function readWebhookResult(response) {
  const acknowledgement = await response.json();
  const recovery = await runRecoveryOnce({ limit: 100 });
  const duplicates = acknowledgement.queued
    .filter((entry) => entry.duplicate)
    .map((entry) => ({ type: entry.type, status: "skipped_duplicate" }));
  const results = [...recovery.results, ...duplicates];
  return {
    ...acknowledgement,
    results,
    comments: results.filter((entry) => entry.type === "comment"),
    messages: results.filter((entry) => entry.type === "message"),
  };
}

const verify = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
assert.equal(await verify.text(), "12345");

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
const healthJson = await health.json();
assert.equal(healthJson.delivery_error_count_24h, 1);
assert.equal(healthJson.delivery_last_error_status, "dm_error");
assert.equal(healthJson.delivery_last_error_keyword, "AGENT");

const payload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-1",
            text: "AGENTIC please",
            from: { id: "user-1" },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const sig = createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex");
const post = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${sig}`,
  },
  body,
});
assert.equal(post.status, 200);
const result = await readWebhookResult(post);
assert.equal(result.results[0].keyword, "AGENTIC");
assert.equal(result.results[0].status, "sent");

const state = await readFile(stateFile, "utf8");
assert.match(state, /"keyword":"AGENTIC"/);
assert.doesNotMatch(state, /"status":"sent","keyword":"AGENT","comment_id":"comment-1"/);
assert.match(state, /קיבלתי את התגובה על AGENTIC/);
assert.doesNotMatch(state, /agentic guide/);
assert.doesNotMatch(state, /follow ask/);
assert.match(state, /"quick_replies":/);
assert.match(state, /CTA_WANTS_GUIDE\|AGENTIC\|media-1/);
assert.match(state, /"public_reply":/);
assert.match(state, /\/replies/);

const duplicate = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${sig}`,
  },
  body,
});
assert.equal(duplicate.status, 200);
const duplicateResult = await readWebhookResult(duplicate);
assert.equal(duplicateResult.results[0].status, "skipped_duplicate");

const nonFollowerPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-2",
            text: "AGENT please",
            from: { id: "user-2", is_follower: false },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const nonFollowerBody = JSON.stringify(nonFollowerPayload);
const nonFollowerSig = createHmac("sha256", process.env.META_APP_SECRET).update(nonFollowerBody).digest("hex");
const nonFollowerPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${nonFollowerSig}`,
  },
  body: nonFollowerBody,
});
assert.equal(nonFollowerPost.status, 200);
const nonFollowerResult = await readWebhookResult(nonFollowerPost);
assert.equal(nonFollowerResult.results[0].keyword, "AGENT");
assert.equal(nonFollowerResult.results[0].status, "sent");

const aliasPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-alias",
            text: "Dou",
            from: { id: "user-alias", is_follower: false },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const aliasBody = JSON.stringify(aliasPayload);
const aliasSig = createHmac("sha256", process.env.META_APP_SECRET).update(aliasBody).digest("hex");
const aliasPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${aliasSig}`,
  },
  body: aliasBody,
});
assert.equal(aliasPost.status, 200);
const aliasResult = await readWebhookResult(aliasPost);
assert.equal(aliasResult.results[0].keyword, "DUO");
assert.equal(aliasResult.results[0].status, "sent");

const typoPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-typo",
            text: "AGNET",
            from: { id: "user-typo", is_follower: false },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const typoBody = JSON.stringify(typoPayload);
const typoSig = createHmac("sha256", process.env.META_APP_SECRET).update(typoBody).digest("hex");
const typoPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${typoSig}`,
  },
  body: typoBody,
});
assert.equal(typoPost.status, 200);
const typoResult = await readWebhookResult(typoPost);
assert.equal(typoResult.results[0].keyword, "AGENT");
assert.equal(typoResult.results[0].status, "sent");

const ambiguousTypoPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-ambiguous-typo",
            text: "AGENTI",
            from: { id: "user-ambiguous-typo", is_follower: false },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const ambiguousTypoBody = JSON.stringify(ambiguousTypoPayload);
const ambiguousTypoSig = createHmac("sha256", process.env.META_APP_SECRET).update(ambiguousTypoBody).digest("hex");
const ambiguousTypoPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${ambiguousTypoSig}`,
  },
  body: ambiguousTypoBody,
});
assert.equal(ambiguousTypoPost.status, 200);
const ambiguousTypoResult = await readWebhookResult(ambiguousTypoPost);
assert.equal(ambiguousTypoResult.results[0].status, "ignored");

const followUpPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-followup",
            text: "עקבתי",
            from: { id: "user-followup", is_follower: true },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const followUpBody = JSON.stringify(followUpPayload);
const followUpSig = createHmac("sha256", process.env.META_APP_SECRET).update(followUpBody).digest("hex");
const followUpPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${followUpSig}`,
  },
  body: followUpBody,
});
assert.equal(followUpPost.status, 200);
const followUpResult = await readWebhookResult(followUpPost);
assert.equal(followUpResult.results[0].keyword, "AGENT");
assert.equal(followUpResult.results[0].status, "sent");

const quickReplyPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      messaging: [
        {
          sender: { id: "user-followup" },
          recipient: { id: "1789" },
          timestamp: 123,
          message: {
            mid: "message-followup",
            text: "עקבתי",
            quick_reply: { payload: "CTA_FOLLOWED|AGENT|media-1" },
          },
        },
      ],
    },
  ],
};
const quickReplyBody = JSON.stringify(quickReplyPayload);
const quickReplySig = createHmac("sha256", process.env.META_APP_SECRET).update(quickReplyBody).digest("hex");
const quickReplyPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${quickReplySig}`,
  },
  body: quickReplyBody,
});
assert.equal(quickReplyPost.status, 200);
const quickReplyResult = await readWebhookResult(quickReplyPost);
assert.equal(quickReplyResult.messages[0].keyword, "AGENT");
assert.equal(quickReplyResult.messages[0].status, "skipped_guide_delivered");

const retryPublicPayload = {
  object: "instagram",
  entry: [
    {
      id: "1789",
      changes: [
        {
          field: "comments",
          value: {
            id: "comment-public-retry",
            text: "AGENT please",
            from: { id: "user-retry", is_follower: true },
            media: { id: "media-1" },
          },
        },
      ],
    },
  ],
};
const retryPublicBody = JSON.stringify(retryPublicPayload);
const retryPublicSig = createHmac("sha256", process.env.META_APP_SECRET).update(retryPublicBody).digest("hex");
const retryPublicPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${retryPublicSig}`,
  },
  body: retryPublicBody,
});
assert.equal(retryPublicPost.status, 200);
const retryPublicResult = await readWebhookResult(retryPublicPost);
assert.equal(retryPublicResult.results[0].keyword, "AGENT");
assert.equal(retryPublicResult.results[0].status, "sent");

const storyReplyPayload = {
  object: "instagram",
  entry: [{
    id: "1789",
    messaging: [{
      sender: { id: "story-user" },
      recipient: { id: "1789" },
      timestamp: 456,
      message: {
        mid: "story-message-webhook",
        text: "AGENT",
        reply_to: {
          story: {
            id: "story-webhook-1",
            url: "https://www.instagram.com/stories/test/1/",
          },
        },
      },
    }],
  }],
};
const storyReplyBody = JSON.stringify(storyReplyPayload);
const storyReplySig = createHmac("sha256", process.env.META_APP_SECRET).update(storyReplyBody).digest("hex");
const storyReplyPost = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${storyReplySig}`,
  },
  body: storyReplyBody,
});
assert.equal(storyReplyPost.status, 200);
const storyReplyResult = await readWebhookResult(storyReplyPost);
assert.equal(storyReplyResult.messages[0].keyword, "AGENT");
assert.equal(storyReplyResult.messages[0].status, "sent");

const finalState = await readFile(stateFile, "utf8");
assert.match(finalState, /קיבלתי את התגובה על AGENT/);
assert.match(finalState, /comment-alias/);
assert.match(finalState, /comment-typo/);
assert.doesNotMatch(finalState, /comment-ambiguous-typo/);
assert.match(finalState, /קיבלתי את התגובה על DUO/);
assert.match(finalState, /comment-followup/);
assert.match(finalState, /message-followup/);
assert.match(finalState, /message_skipped_guide_delivered/);
assert.match(finalState, /agent guide/);
assert.match(finalState, /utm_campaign=test-agent-campaign/);
assert.match(finalState, /utm_content=media-1/);
assert.match(finalState, /cta=AGENT/);
assert.match(finalState, /delivery_id=[A-Za-z0-9_-]{32}/);
assert.doesNotMatch(finalState, /delivery_id=user-followup/);
assert.match(finalState, /comment-public-retry/);
assert.match(finalState, /"dm":\{"skipped_duplicate":true\}/);
assert.match(finalState, /"public_reply":/);
assert.match(finalState, /"source":"story_reply"/);
assert.match(finalState, /"story_id":"story-webhook-1"/);

const webhookLog = await readFile(process.env.WEBHOOK_LOG_FILE, "utf8");
assert.match(webhookLog, /"comment_count":1/);
assert.match(webhookLog, /"message_count":1/);
assert.doesNotMatch(webhookLog, /AGENTIC please/);
assert.doesNotMatch(webhookLog, /user-1/);

server.close();
