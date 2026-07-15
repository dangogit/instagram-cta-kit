import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-follow-gate-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");
const oldAt = "2026-07-02T08:00:00.000Z";

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "DUO",
      reply_text: "הנה המדריך שביקשת:\nhttps://example.com/guides/duo",
      requires_follow: true,
      non_follower_text: "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי",
      public_reply_text: "אצלך בפרטי 🔥",
    },
    {
      keyword: "CLAUDE",
      reply_text: "הנה המדריך שביקשת:\nhttps://example.com/guides/claude",
      requires_follow: true,
      non_follower_text: "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי",
      public_reply_text: "אצלך בפרטי 🔥",
    },
  ],
}));

await writeFile(stateFile, [
  {
    status: "sent",
    keyword: "CLAUDE",
    comment_id: "comment-remind-old",
    media_id: "media-old",
    from_id: "user-remind",
    follower_state: false,
    at: "2026-07-02T07:59:00.000Z",
  },
  {
    status: "sent",
    keyword: "DUO",
    comment_id: "comment-remind",
    media_id: "media-1",
    from_id: "user-remind",
    follower_state: false,
    at: oldAt,
  },
  {
    status: "sent",
    keyword: "DUO",
    comment_id: "comment-guide",
    media_id: "media-1",
    from_id: "user-guide",
    follower_state: false,
    at: oldAt,
  },
  {
    status: "sent",
    keyword: "CLAUDE",
    comment_id: "comment-guide-old",
    media_id: "media-old",
    from_id: "user-guide",
    follower_state: false,
    at: "2026-07-02T07:59:00.000Z",
  },
].map((event) => JSON.stringify(event)).join("\n") + "\n");

process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = "secret";
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.GRAPH_BASE_URL = "https://fake.meta.local/v25.0";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.WEBHOOK_LOG_FILE = join(tmp, "state", "webhooks.jsonl");
process.env.DRY_RUN = "0";
process.env.FOLLOW_GATE_GUIDE_ENABLED = "1";

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  calls.push({
    path: parsed.pathname,
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });

  if (parsed.pathname.endsWith("/user-remind")) {
    return Response.json({ id: "user-remind", is_user_follow_business: false });
  }
  if (parsed.pathname.endsWith("/user-guide")) {
    return Response.json({ id: "user-guide", is_user_follow_business: true });
  }
  if (parsed.pathname.endsWith("/1789/messages")) {
    return Response.json({ id: `dm-${calls.length}` });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { processMessages, processPendingFollowGate } = await import("../src/server.mjs");

const first = await processPendingFollowGate(null, new Date("2026-07-02T08:02:00.000Z"));
assert.deepEqual(first, [
  { fromId: "user-remind", keyword: "DUO", status: "awaiting_follow" },
  { fromId: "user-guide", keyword: "DUO", status: "follow_gate_guide_sent" },
]);

assert.equal(calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-remind").length, 0);
const guideCall = calls.find((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-guide");
assert.equal(guideCall.body.message.text, "הנה המדריך שביקשת:\nhttps://example.com/guides/duo");

const state = await readFile(stateFile, "utf8");
assert.doesNotMatch(state, /follow_gate_reminder_sent/);
assert.match(state, /follow_gate_guide_sent/);

const second = await processPendingFollowGate(null, new Date());
assert.deepEqual(second, [
  { fromId: "user-remind", keyword: "DUO", status: "awaiting_follow" },
]);

const afterGuideMessage = await processMessages([
  {
    igUserId: "1789",
    senderId: "user-guide",
    messageId: "message-after-guide",
    text: "עקבתי",
    payload: "",
    raw: {},
  },
]);
assert.deepEqual(afterGuideMessage, [{ messageId: "message-after-guide", status: "ignored" }]);
assert.equal(calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-guide").length, 1);
