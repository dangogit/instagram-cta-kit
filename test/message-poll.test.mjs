import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-message-poll-"));
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

await writeFile(stateFile, `${JSON.stringify({
  status: "sent",
  keyword: "AGENT",
  comment_id: "comment-1",
  media_id: "media-1",
  from_id: "user-1",
  follower_state: false,
  at: "2026-07-02T08:00:00.000Z",
})}\n${JSON.stringify({
  status: "sent",
  keyword: "AGENT",
  comment_id: "comment-2",
  media_id: "media-1",
  from_id: "user-2",
  follower_state: false,
  at: "2026-07-02T08:00:00.000Z",
})}\n`);

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
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(String(url));
  calls.push({
    path: parsed.pathname,
    method: options.method || "GET",
    body: options.body ? JSON.parse(options.body) : null,
  });

  if (parsed.pathname.endsWith("/1789/media")) {
    return Response.json({ data: [] });
  }
  if (parsed.pathname.endsWith("/1789/conversations")) {
    return Response.json({
      data: [
        {
          id: "conversation-1",
          messages: {
            data: [
              {
                id: "message-followed",
                message: "כן",
                from: { id: "user-1" },
                created_time: "2026-07-02T08:05:00+0000",
              },
              {
                id: "message-send",
                message: "שלח",
                from: { id: "user-1" },
                created_time: "2026-07-02T08:05:04+0000",
              },
              {
                id: "message-outbound",
                message: "ignore outbound",
                from: { id: "1789" },
                created_time: "2026-07-02T08:04:00+0000",
              },
              {
                id: "message-old",
                message: "התחלתי לעקוב",
                from: { id: "user-1" },
                created_time: "2026-07-01T08:04:00+0000",
              },
              {
                id: "message-still-not-following",
                message: "התחלתי לעקוב",
                from: { id: "user-2" },
                created_time: "2026-07-02T08:06:00+0000",
              },
              {
                id: "message-still-send",
                message: "שלח",
                from: { id: "user-2" },
                created_time: "2026-07-02T08:06:04+0000",
              },
            ],
          },
        },
      ],
    });
  }
  if (parsed.pathname.endsWith("/user-1")) {
    return Response.json({ id: "user-1", is_user_follow_business: true });
  }
  if (parsed.pathname.endsWith("/user-2")) {
    return Response.json({ id: "user-2", is_user_follow_business: false });
  }
  if (parsed.pathname.endsWith("/1789/messages")) {
    return Response.json({ id: "dm-guide" });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { pollOnce } = await import("../src/server.mjs");

const results = await pollOnce();
assert.deepEqual(results, [
  { messageId: "message-followed", keyword: "AGENT", status: "sent" },
  { messageId: "message-send", status: "ignored" },
  { messageId: "message-still-not-following", keyword: "AGENT", status: "sent" },
  { messageId: "message-still-send", keyword: "AGENT", status: "skipped_duplicate_action" },
]);

const guideCalls = calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-1");
assert.equal(guideCalls.length, 1);
const [guideCall] = guideCalls;
assert.equal(guideCall.body.message.text, "הנה המדריך שביקשת:\nhttps://example.com/guides/agent");
const promptCalls = calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-2");
assert.equal(promptCalls.length, 1);
assert.equal(promptCalls[0].body.message.text, "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי");

const state = await readFile(stateFile, "utf8");
assert.match(state, /message-followed/);
assert.match(state, /message_skipped_duplicate_action/);
assert.doesNotMatch(state, /message-old/);
assert.doesNotMatch(state, /message-outbound/);
