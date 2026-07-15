import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

// Regression: the CTA funnel must be able to match a Hebrew story-reply keyword
// (e.g. "פידבק"). The original tokenizer used /[A-Z0-9]+/g, which strips Hebrew
// characters entirely, so a Hebrew keyword could never match.

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-hebrew-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "פידבק",
      intro_text: "קיבלתי את התגובה שלך על פידבק. רוצה שאשלח לך את המדריך?",
      reply_text: "הנה המדריך שביקשת:\nhttps://example.com/guides/feedback/",
      requires_follow: true,
      non_follower_text: "כדי לקבל את הלינק, צריך לעקוב אחרי החשבון ואז ללחוץ כאן",
      public_reply_text: "אצלך בפרטי 🔥",
    },
    {
      keyword: "DESIGN",
      reply_text: "design guide",
      public_reply_text: "אצלך בפרטי 🔥",
    },
  ],
}));
await writeFile(stateFile, "");

process.env.VERIFY_TOKEN = "verify-me";
process.env.META_APP_SECRET = "secret";
process.env.IG_USER_ID = "1789";
process.env.IG_ACCESS_TOKEN = "token";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;
process.env.DRY_RUN = "1";

const { processMessages } = await import("../src/server.mjs");

// 1. A single-word Hebrew story reply matches the Hebrew keyword route.
const results = await processMessages([{
  igUserId: "1789",
  senderId: "he-story-user",
  messageId: "he-message-1",
  text: "פידבק",
  payload: "",
  storyId: "story-he-1",
  storyUrl: "https://www.instagram.com/stories/example/he-1/",
  raw: { message: { reply_to: { story: { id: "story-he-1" } } } },
}]);

assert.deepEqual(results, [{ messageId: "he-message-1", keyword: "פידבק", status: "sent" }]);

const state = await readFile(stateFile, "utf8");
assert.match(state, /"source":"story_reply"/);
assert.match(state, /"story_id":"story-he-1"/);
assert.match(state, /קיבלתי את התגובה שלך על פידבק/);
assert.match(state, /CTA_WANTS_GUIDE\|פידבק\|story-he-1/);

// 2. Latin keywords still work unchanged (no regression).
const latin = await processMessages([{
  igUserId: "1789",
  senderId: "latin-user",
  messageId: "latin-message-1",
  text: "DESIGN",
  payload: "",
  storyId: "story-latin-1",
  raw: { message: { reply_to: { story: { id: "story-latin-1" } } } },
}]);
assert.deepEqual(latin, [{ messageId: "latin-message-1", keyword: "DESIGN", status: "sent" }]);

// 3. A multi-word Hebrew reply is ignored (mirrors the Latin "I need DUO" guard).
const sentence = await processMessages([{
  igUserId: "1789",
  senderId: "he-user-2",
  messageId: "he-message-2",
  text: "רוצה פידבק",
  payload: "",
  raw: {},
}]);
assert.deepEqual(sentence, [{ messageId: "he-message-2", status: "ignored" }]);

console.log("hebrew-keyword.test.mjs passed");
