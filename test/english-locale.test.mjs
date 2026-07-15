import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-english-"));
await mkdir(join(tmp, "state"));
const stateFile = join(tmp, "state", "events.jsonl");
await writeFile(stateFile, "");
await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [{
    keyword: "GUIDE",
    campaign_id: "english-guide",
    guide_url: "https://example.com/guide",
    reply_text: "Here is the guide:\nhttps://example.com/guide",
    requires_follow: false,
  }],
}));

process.env.DEFAULT_LOCALE = "en";
process.env.VERIFY_TOKEN = "verify";
process.env.DRY_RUN = "1";
process.env.CTA_ATTRIBUTION_SECRET = "test-secret";
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = stateFile;

const { processComments } = await import("../src/server.mjs");
const result = await processComments([{
  igUserId: "account",
  commentId: "comment-1",
  mediaId: "media-1",
  text: "GUIDE",
  fromId: "person-1",
  followerState: null,
  raw: {},
}]);

assert.deepEqual(result, [{ commentId: "comment-1", keyword: "GUIDE", status: "sent" }]);
const state = await readFile(stateFile, "utf8");
assert.match(state, /Thanks for your comment about GUIDE/);
assert.match(state, /Yes, send it/);
assert.match(state, /Sent you a DM/);

console.log("english-locale.test.mjs passed");
