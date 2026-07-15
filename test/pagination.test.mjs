import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-pagination-"));
await mkdir(join(tmp, "state"));

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [{
    keyword: "DESIGN",
    reply_text: "הנה האתר שביקשת:\nhttps://styles.refero.design/",
    requires_follow: true,
    non_follower_text: "כדי לקבל את הלינק, צריך לעקוב אחרי החשבון ואז ללחוץ כאן",
    public_reply_text: "אצלך בפרטי 🔥",
  }],
}));
await writeFile(join(tmp, "state", "events.jsonl"), "");

process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = "secret";
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.GRAPH_BASE_URL = "https://fake.meta.local/v25.0";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = join(tmp, "state", "events.jsonl");
process.env.DRY_RUN = "1";
process.env.POLL_SINCE_ISO = "2026-07-11T00:00:00.000Z";
process.env.POLL_COMMENTS_LIMIT = "1";
process.env.POLL_CONVERSATION_LIMIT = "1";
process.env.POLL_MESSAGES_LIMIT = "1";

const calls = [];
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url));
  calls.push(`${parsed.pathname}?after=${parsed.searchParams.get("after") || ""}`);

  if (parsed.pathname.endsWith("/1789/media")) {
    return Response.json({ data: [{ id: "media-1", timestamp: "2026-07-11T08:00:00+0000" }] });
  }
  if (parsed.pathname.endsWith("/media-1/comments")) {
    if (parsed.searchParams.get("after") === "comments-2") {
      return Response.json({ data: [{ id: "comment-page-2", text: "DESIGN", timestamp: "2026-07-11T08:02:00+0000", from: { id: "comment-user" } }] });
    }
    return Response.json({
      data: [],
      paging: { next: "present", cursors: { after: "comments-2" } },
    });
  }
  if (parsed.pathname.endsWith("/1789/conversations")) {
    if (parsed.searchParams.get("after") === "conversations-2") {
      return Response.json({ data: [{ id: "conversation-2", updated_time: "2026-07-11T08:05:00+0000" }] });
    }
    return Response.json({
      data: [],
      paging: { next: "present", cursors: { after: "conversations-2" } },
    });
  }
  if (parsed.pathname.endsWith("/conversation-2/messages")) {
    if (parsed.searchParams.get("after") === "messages-2") {
      return Response.json({ data: [{
        id: "story-page-2",
        message: "DESIGN",
        from: { id: "story-user" },
        created_time: "2026-07-11T08:04:00+0000",
        reply_to: { story: { id: "story-456", url: "https://www.instagram.com/stories/test/456/" } },
      }] });
    }
    return Response.json({
      data: [],
      paging: { next: "present", cursors: { after: "messages-2" } },
    });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { pollOnce } = await import("../src/server.mjs");
const results = await pollOnce();

assert.deepEqual(results, [
  { commentId: "comment-page-2", keyword: "DESIGN", status: "sent" },
  { messageId: "story-page-2", keyword: "DESIGN", status: "sent" },
]);
assert.ok(calls.includes("/v25.0/media-1/comments?after=comments-2"));
assert.ok(calls.includes("/v25.0/1789/conversations?after=conversations-2"));
assert.ok(calls.includes("/v25.0/conversation-2/messages?after=messages-2"));
