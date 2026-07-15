import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-cursor-"));
await mkdir(join(tmp, "state"));
const cursorFile = join(tmp, "state", "poll-cursor.json");

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "AGENT",
      reply_text: "הנה המדריך שביקשת:\nhttps://example.com/guides/agent",
      public_reply_text: "אצלך בפרטי 🔥",
    },
  ],
}));

process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = "secret";
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.GRAPH_BASE_URL = "https://fake.meta.local/v25.0";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = join(tmp, "state", "events.jsonl");
process.env.POLL_CURSOR_FILE = cursorFile;
process.env.DRY_RUN = "1";
delete process.env.POLL_SINCE_ISO;

globalThis.fetch = async (url) => {
  const parsed = new URL(String(url));
  if (parsed.pathname.endsWith("/1789/media")) {
    return Response.json({ data: [{ id: "media-1", timestamp: new Date().toISOString() }] });
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
          timestamp: new Date(Date.now() + 60000).toISOString(),
          from: { id: "user-1" },
        },
      ],
    });
  }
  return Response.json({ error: { message: `unexpected ${parsed.pathname}` } }, { status: 500 });
};

const { pollOnce } = await import("../src/server.mjs");

const results = await pollOnce();
assert.equal(results[0].status, "sent");

const cursor = JSON.parse(await readFile(cursorFile, "utf8"));
assert.match(cursor.since_iso, /^\d{4}-\d{2}-\d{2}T/);
