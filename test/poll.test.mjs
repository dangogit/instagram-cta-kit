import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-poll-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "AGENT",
      reply_text: "הנה המדריך שביקשת:\nhttps://example.com/guides/agent",
      requires_follow: true,
      non_follower_text: "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי",
      public_reply_text: "אצלך בפרטי 🔥",
    },
  ],
}));
await writeFile(stateFile, "");

process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = "secret";
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.GRAPH_BASE_URL = "https://fake.meta.local/v25.0";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.DRY_RUN = "0";
process.env.POLL_SINCE_ISO = "2026-07-02T00:00:00.000Z";

const calls = [];
let user1LookupCount = 0;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  calls.push({
    path: parsed.pathname,
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });

  if (parsed.pathname.endsWith("/1789/media")) {
    return Response.json({
      data: [
        { id: "media-1", permalink: "https://www.instagram.com/p/test/", timestamp: "2026-07-02T08:00:00+0000" },
      ],
    });
  }
  if (parsed.pathname.endsWith("/1789/conversations")) {
    return Response.json({ data: [] });
  }
  if (parsed.pathname.endsWith("/media-1/comments")) {
    return Response.json({
      data: [
        {
          id: "comment-1",
          text: "AGENT",
          timestamp: "2026-07-02T08:01:00+0000",
          from: { id: "user-1" },
        },
        {
          id: "comment-dm-fail",
          text: "AGENT",
          timestamp: "2026-07-02T08:02:00+0000",
          from: { id: "user-dm-fail" },
        },
        {
          id: "comment-followed",
          text: "עקבתי",
          timestamp: "2026-07-02T08:03:00+0000",
          from: { id: "user-1", is_follower: true },
        },
        {
          id: "comment-old",
          text: "AGENT",
          timestamp: "2026-07-01T08:01:00+0000",
          from: { id: "user-old" },
        },
      ],
    });
  }
  if (parsed.pathname.endsWith("/user-1")) {
    user1LookupCount += 1;
    return Response.json({ id: "user-1", is_user_follow_business: user1LookupCount > 1 });
  }
  if (parsed.pathname.endsWith("/user-dm-fail")) {
    return Response.json({ id: "user-dm-fail", is_user_follow_business: true });
  }
  if (parsed.pathname.endsWith("/user-still-not-following")) {
    return Response.json({ id: "user-still-not-following", is_user_follow_business: false });
  }
  if (parsed.pathname.endsWith("/user-lookup-throws")) {
    throw new Error("profile lookup failed");
  }
  if (parsed.pathname.endsWith("/1789/messages")) {
    const body = JSON.parse(options.body);
    if (body.recipient.comment_id === "comment-dm-fail") {
      return Response.json({ error: { message: "dm blocked" } }, { status: 500 });
    }
    return Response.json({ id: "dm-1" });
  }
  if (parsed.pathname.endsWith("/comment-1/replies")) {
    return Response.json({ id: "public-reply-1" });
  }
  if (parsed.pathname.endsWith("/comment-dm-fail/replies")) {
    return Response.json({ id: "public-reply-dm-fail" });
  }
  if (parsed.pathname.endsWith("/comment-followed/replies")) {
    return Response.json({ id: "public-reply-followed" });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { pollOnce, processMessages } = await import("../src/server.mjs");

const first = await pollOnce();
assert.deepEqual(first, [
  { commentId: "comment-1", keyword: "AGENT", status: "sent" },
  { commentId: "comment-dm-fail", keyword: "AGENT", status: "dm_error" },
  { commentId: "comment-followed", keyword: "AGENT", status: "sent" },
]);

const dmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.comment_id === "comment-1");
assert.equal(dmCall.body.message.text, "קיבלתי את התגובה על AGENT. לשלוח את המדריך?");
assert.deepEqual(dmCall.body.message.quick_replies, [
  { content_type: "text", title: "כן, אפשר לשלוח", payload: "CTA_WANTS_GUIDE|AGENT|media-1" },
]);
const failedDmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.comment_id === "comment-dm-fail");
assert.equal(failedDmCall.body.message.text, "קיבלתי את התגובה על AGENT. לשלוח את המדריך?");
const followUpDmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.comment_id === "comment-followed");
assert.equal(followUpDmCall.body.message.text, "הנה המדריך שביקשת:\nhttps://example.com/guides/agent");
assert.deepEqual(followUpDmCall.body.message.quick_replies, [
  { content_type: "text", title: "עוד מדריך", payload: "CTA_MORE_GUIDES" },
  { content_type: "text", title: "יש לי שאלה", payload: "CTA_QUESTION" },
  { content_type: "text", title: "סיימתי", payload: "CTA_DONE" },
]);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-1/replies")).length, 1);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-dm-fail/replies")).length, 0);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-followed/replies")).length, 1);

const messageResult = await processMessages([
  {
    igUserId: "1789",
    senderId: "user-dm-fail",
    messageId: "message-followed",
    text: "עקבתי",
    payload: "CTA_FOLLOWED|AGENT|media-1",
    raw: {},
  },
]);
assert.deepEqual(messageResult, [{ messageId: "message-followed", keyword: "AGENT", status: "sent" }]);
const messageDmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-dm-fail");
assert.equal(messageDmCall.body.message.text, "הנה המדריך שביקשת:\nhttps://example.com/guides/agent");
assert.deepEqual(messageDmCall.body.message.quick_replies, [
  { content_type: "text", title: "עוד מדריך", payload: "CTA_MORE_GUIDES" },
  { content_type: "text", title: "יש לי שאלה", payload: "CTA_QUESTION" },
  { content_type: "text", title: "סיימתי", payload: "CTA_DONE" },
]);

const stillNotFollowingResult = await processMessages([
  {
    igUserId: "1789",
    senderId: "user-still-not-following",
    messageId: "message-still-not-following",
    text: "התחלתי לעקוב",
    payload: "CTA_FOLLOWED|AGENT|media-1",
    raw: {},
  },
]);
assert.deepEqual(stillNotFollowingResult, [{ messageId: "message-still-not-following", keyword: "AGENT", status: "sent" }]);
const stillNotFollowingDmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-still-not-following");
assert.equal(stillNotFollowingDmCall.body.message.text, "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי");
assert.deepEqual(stillNotFollowingDmCall.body.message.quick_replies, [
  { content_type: "text", title: "התחלתי לעקוב", payload: "CTA_FOLLOWED|AGENT|media-1" },
]);

const lookupThrowsResult = await processMessages([
  {
    igUserId: "1789",
    senderId: "user-lookup-throws",
    messageId: "message-lookup-throws",
    text: "התחלתי לעקוב",
    payload: "CTA_FOLLOWED|AGENT|media-1",
    raw: {},
  },
]);
assert.deepEqual(lookupThrowsResult, [{ messageId: "message-lookup-throws", keyword: "AGENT", status: "sent" }]);
const lookupThrowsDmCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-lookup-throws");
assert.equal(lookupThrowsDmCall.body.message.text, "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי");
assert.deepEqual(lookupThrowsDmCall.body.message.quick_replies, [
  { content_type: "text", title: "התחלתי לעקוב", payload: "CTA_FOLLOWED|AGENT|media-1" },
]);

const duplicateMessageResult = await processMessages([
  {
    igUserId: "1789",
    senderId: "user-dm-fail",
    messageId: "message-followed",
    text: "עקבתי",
    payload: "CTA_FOLLOWED|AGENT|media-1",
    raw: {},
  },
]);
assert.deepEqual(duplicateMessageResult, [{ messageId: "message-followed", status: "skipped_duplicate" }]);

const state = await readFile(stateFile, "utf8");
assert.match(state, /"comment_id":"comment-1"/);
assert.match(state, /"comment_id":"comment-dm-fail"/);
assert.match(state, /"comment_id":"comment-followed"/);
assert.match(state, /message-followed/);
assert.match(state, /message-still-not-following/);
assert.match(state, /message-lookup-throws/);
assert.match(state, /"status":"dm_error"/);
assert.doesNotMatch(state, /"status":"public_reply_sent"/);
assert.doesNotMatch(state, /comment-old/);

const second = await pollOnce();
assert.deepEqual(second, [
  { commentId: "comment-1", keyword: "AGENT", status: "skipped_duplicate" },
  { commentId: "comment-dm-fail", keyword: "AGENT", status: "dm_error" },
  { commentId: "comment-followed", keyword: "AGENT", status: "skipped_duplicate" },
]);
assert.equal(calls.filter((call) => call.path.endsWith("/1789/messages")).length, 11);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-1/replies")).length, 1);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-dm-fail/replies")).length, 0);
assert.equal(calls.filter((call) => call.path.endsWith("/comment-followed/replies")).length, 1);
