import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-pending-freetext-"));
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

const pendingEvent = (fromId) => JSON.stringify({
  status: "sent",
  keyword: "AGENT",
  comment_id: `comment-${fromId}`,
  media_id: "media-1",
  from_id: fromId,
  follower_state: false,
  at: "2026-07-02T08:00:00.000Z",
});
const priorPrompt = (fromId, messageId) => JSON.stringify({
  status: "message_sent",
  keyword: "AGENT",
  message_id: messageId,
  media_id: "media-1",
  from_id: fromId,
  follower_state: false,
  at: "2026-07-02T08:01:00.000Z",
});

await writeFile(stateFile, [
  pendingEvent("user-1"),
  pendingEvent("user-2"),
  pendingEvent("user-3"),
  priorPrompt("user-3", "prior-prompt-1"),
  priorPrompt("user-3", "prior-prompt-2"),
].join("\n") + "\n");

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
                id: "message-freetext-followed",
                message: "מה קורה עם המדריך?",
                from: { id: "user-1" },
                created_time: "2026-07-02T08:05:00+0000",
              },
              {
                id: "message-freetext-not-following",
                message: "למה לא קיבלתי כלום",
                from: { id: "user-2" },
                created_time: "2026-07-02T08:06:00+0000",
              },
              {
                id: "message-freetext-capped",
                message: "עדיין מחכה",
                from: { id: "user-3" },
                created_time: "2026-07-02T08:07:00+0000",
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
  if (parsed.pathname.endsWith("/user-3")) {
    return Response.json({ id: "user-3", is_user_follow_business: false });
  }
  if (parsed.pathname.endsWith("/1789/messages")) {
    return Response.json({ id: "dm-guide" });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { pollOnce } = await import("../src/server.mjs");

const results = await pollOnce();
assert.deepEqual(results, [
  { messageId: "message-freetext-followed", keyword: "AGENT", status: "sent" },
  { messageId: "message-freetext-not-following", keyword: "AGENT", status: "sent" },
  { messageId: "message-freetext-capped", keyword: "AGENT", status: "ignored" },
]);

const user1Calls = calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-1");
assert.equal(user1Calls.length, 1);
assert.equal(user1Calls[0].body.message.text, "הנה המדריך שביקשת:\nhttps://example.com/guides/agent");

const user2Calls = calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-2");
assert.equal(user2Calls.length, 1);
assert.equal(user2Calls[0].body.message.text, "המדריך מחכה כאן. צריך לעקוב אחרי @example ואז לכתוב כאן עקבתי");

const user3Calls = calls.filter((call) => call.path.endsWith("/1789/messages") && call.body.recipient.id === "user-3");
assert.equal(user3Calls.length, 0);

const state = await readFile(stateFile, "utf8");
assert.match(state, /non_follower_prompt_capped/);
assert.match(state, /"source":"pending_free_text"/);
