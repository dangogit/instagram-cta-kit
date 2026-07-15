import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEFAULT_LOCALE = "he";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-story-message-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "DESIGN",
      intro_text: "קיבלתי את התגובה על DESIGN. לשלוח את המדריך?",
      reply_text: "הנה האתר שביקשת:\nhttps://styles.refero.design/",
      requires_follow: true,
      non_follower_text: "כדי לקבל את הלינק, צריך לעקוב אחרי החשבון ואז ללחוץ כאן",
      public_reply_text: "אצלך בפרטי 🔥",
    },
    {
      keyword: "DUO",
      aliases: ["DOU"],
      reply_text: "duo guide",
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

const results = await processMessages([{
  igUserId: "1789",
  senderId: "story-user",
  messageId: "story-message-1",
  text: "Design",
  payload: "",
  storyId: "story-123",
  storyUrl: "https://www.instagram.com/stories/test/123/",
  raw: { message: { reply_to: { story: { id: "story-123" } } } },
}]);

assert.deepEqual(results, [{ messageId: "story-message-1", keyword: "DESIGN", status: "sent" }]);

const state = await readFile(stateFile, "utf8");
assert.match(state, /"source":"story_reply"/);
assert.match(state, /"story_id":"story-123"/);
assert.match(state, /קיבלתי את התגובה על DESIGN/);
assert.match(state, /CTA_WANTS_GUIDE\|DESIGN\|story-123/);
assert.doesNotMatch(state, /https:\/\/styles\.refero\.design/);

const normalMessage = await processMessages([{
  igUserId: "1789",
  senderId: "normal-user",
  messageId: "normal-message-1",
  text: "Thank you",
  payload: "",
  raw: {},
}]);
assert.deepEqual(normalMessage, [{ messageId: "normal-message-1", status: "ignored" }]);

const sentenceWithKeyword = await processMessages([{
  igUserId: "1789",
  senderId: "normal-user-2",
  messageId: "normal-message-2",
  text: "I need DUO",
  payload: "",
  raw: {},
}]);
assert.deepEqual(sentenceWithKeyword, [{ messageId: "normal-message-2", status: "ignored" }]);
