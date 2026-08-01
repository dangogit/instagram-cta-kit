import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = resolve(root, "bin/instagram-cta.mjs");
const home = await mkdtemp(join(tmpdir(), "instagram-cta-cli-"));

const init = spawnSync(process.execPath, [cli, "init", "--dir", home, "--locale", "he", "--mode", "polling"], { encoding: "utf8" });
assert.equal(init.status, 0, init.stderr);

const env = await readFile(join(home, ".env"), "utf8");
assert.match(env, /DEFAULT_LOCALE=he/);
assert.match(env, /POLL_ENABLED=1/);
assert.match(env, /DRY_RUN=1/);
assert.match(env, /CTA_PROVIDER=hookmyapp/);
assert.match(env, /INSTAGRAM_GRAPH_API_URL=/);
assert.match(env, /WEBHOOK_HMAC_SECRET=/);
assert.match(env, /CTA_ADMIN_TOKEN=[a-f0-9]{64}/);
assert.match(env, /CTA_QUEUE_DIR=\.\/state\/inbox/);
assert.match(env, /RECONCILIATION_STATUS_FILE=\.\/state\/reconciliation-status\.json/);
assert.doesNotMatch(env, /replace-with-a-random-webhook-verify-token/);
if (process.platform !== "win32") {
  assert.equal((await stat(join(home, ".env"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, "routes.json"))).mode & 0o777, 0o644);
}

const routes = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
assert.equal(routes.routes.length, 2);

// The example routes point at example.com, so --check-guides must skip them
// instead of failing a first run with two unavoidable 404s.
const seededGuideCheck = spawnSync(process.execPath, [cli, "routes", "validate", "--dir", home, "--check-guides"], { encoding: "utf8" });
assert.equal(seededGuideCheck.status, 0, `${seededGuideCheck.stdout}\n${seededGuideCheck.stderr}`);
assert.match(seededGuideCheck.stdout, /skipped guide check for 2 example routes/);
assert.match(seededGuideCheck.stdout, /routes ok: 2/);
assert.match(seededGuideCheck.stderr, /still points at the placeholder URL/);
assert.match(seededGuideCheck.stderr, /instagram-cta route remove GUIDE/);

const doctor = spawnSync(process.execPath, [cli, "doctor", "--dir", home], { encoding: "utf8" });
assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
assert.match(doctor.stdout, /route validation: passed/);

const add = spawnSync(process.execPath, [
  cli,
  "route",
  "add",
  "CHECKLIST",
  "https://example.com/checklist",
  "--dir",
  home,
  "--campaign-id",
  "first-checklist",
  "--locale",
  "en",
], { encoding: "utf8" });
assert.equal(add.status, 0, add.stderr);

const updated = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
const added = updated.routes.find((route) => route.keyword === "CHECKLIST");
assert.equal(added.campaign_id, "first-checklist");
assert.equal(added.requires_follow, undefined);
assert.match(added.reply_text, /https:\/\/example\.com\/checklist/);

const badUrl = spawnSync(process.execPath, [
  cli,
  "route",
  "add",
  "BADURL",
  "https://user:password@example.com/guide",
  "--dir",
  home,
  "--campaign-id",
  "bad-url",
], { encoding: "utf8" });
assert.notEqual(badUrl.status, 0);
assert.match(badUrl.stderr, /valid https URL without embedded credentials/);
assert.doesNotMatch(badUrl.stderr, /at file:\/\/|node:internal/);

// route remove is the supported way to drop a keyword without hand editing JSON.
const removeExample = spawnSync(process.execPath, [cli, "route", "remove", "GUIDE", "--dir", home], { encoding: "utf8" });
assert.equal(removeExample.status, 0, removeExample.stderr);
assert.match(removeExample.stdout, /removed GUIDE -> https:\/\/example\.com\/guide/);
assert.match(removeExample.stdout, /routes left: 2/);

const removeHebrew = spawnSync(process.execPath, [cli, "route", "remove", "מדריך", "--dir", home], { encoding: "utf8" });
assert.equal(removeHebrew.status, 0, removeHebrew.stderr);

const afterRemove = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
assert.deepEqual(afterRemove.routes.map((route) => route.keyword), ["CHECKLIST"]);

const removeMissing = spawnSync(process.execPath, [cli, "route", "remove", "NOSUCHKEYWORD", "--dir", home], { encoding: "utf8" });
assert.notEqual(removeMissing.status, 0);
assert.match(removeMissing.stderr, /NOSUCHKEYWORD is not in /);
assert.match(removeMissing.stderr, /Keywords in this file: CHECKLIST/);
assert.doesNotMatch(removeMissing.stderr, /at file:\/\/|node:internal/);

// Two routes can share a keyword when their media_ids do not overlap, so
// removal has to ask which one instead of guessing.
const ambiguous = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
ambiguous.routes.push({
  keyword: "CHECKLIST",
  campaign_id: "post-scoped-checklist",
  guide_url: "https://example.com/other-checklist",
  reply_text: "Other: https://example.com/other-checklist",
  media_ids: ["media_123"],
});
await writeFile(join(home, "routes.json"), `${JSON.stringify(ambiguous, null, 2)}\n`);

const removeAmbiguous = spawnSync(process.execPath, [cli, "route", "remove", "CHECKLIST", "--dir", home], { encoding: "utf8" });
assert.notEqual(removeAmbiguous.status, 0);
assert.match(removeAmbiguous.stderr, /matches 2 routes/);
assert.match(removeAmbiguous.stderr, /--media-id MEDIA_ID/);

const removeScoped = spawnSync(process.execPath, [cli, "route", "remove", "CHECKLIST", "--media-id", "media_123", "--dir", home], { encoding: "utf8" });
assert.equal(removeScoped.status, 0, removeScoped.stderr);
const afterScoped = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
assert.equal(afterScoped.routes.length, 1);
assert.equal(afterScoped.routes[0].media_ids, undefined);

const withAlias = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
withAlias.routes.push({
  keyword: "ALIASROUTE",
  aliases: ["CHECKLIST"],
  campaign_id: "alias-collision",
  guide_url: "https://example.com/alias",
  reply_text: "Alias: https://example.com/alias",
});
await writeFile(join(home, "routes.json"), `${JSON.stringify(withAlias, null, 2)}\n`);
const aliasCollision = spawnSync(process.execPath, [cli, "routes", "validate", "--dir", home], { encoding: "utf8" });
assert.notEqual(aliasCollision.status, 0);
assert.match(aliasCollision.stderr, /duplicate keyword or alias/);
// A validation failure must read as a numbered problem list, not a Node assertion dump.
assert.match(aliasCollision.stderr, /routes validation failed: 1 problem/);
assert.match(aliasCollision.stderr, /^ {2}1\. /m);
assert.match(aliasCollision.stderr, /Fix the routes above, then run the command again\./);
assert.doesNotMatch(aliasCollision.stderr, /AssertionError|ERR_ASSERTION|generatedMessage|at file:\/\/|node:internal/);

const missingDir = spawnSync(process.execPath, [cli, "routes", "validate", "--dir", join(home, "no-such-folder")], { encoding: "utf8" });
assert.notEqual(missingDir.status, 0);
assert.match(missingDir.stderr, /does not exist\. Run instagram-cta init/);
assert.doesNotMatch(missingDir.stderr, /spawnSync|ENOENT/);

const emptyHome = await mkdtemp(join(tmpdir(), "instagram-cta-empty-"));
const missingRoutes = spawnSync(process.execPath, [cli, "routes", "validate", "--dir", emptyHome], { encoding: "utf8" });
assert.notEqual(missingRoutes.status, 0);
assert.match(missingRoutes.stderr, /routes file not found/);
assert.match(missingRoutes.stderr, /Run instagram-cta init first/);
assert.doesNotMatch(missingRoutes.stderr, /at file:\/\/|node:internal/);

const missingRoutesAdd = spawnSync(process.execPath, [cli, "route", "add", "X2", "https://example.com/x", "--dir", emptyHome, "--campaign-id", "x2"], { encoding: "utf8" });
assert.notEqual(missingRoutesAdd.status, 0);
assert.match(missingRoutesAdd.stderr, /routes file not found/);
assert.doesNotMatch(missingRoutesAdd.stderr, /at file:\/\/|node:internal/);

const metaHome = await mkdtemp(join(tmpdir(), "instagram-cta-cli-meta-"));
const metaInit = spawnSync(process.execPath, [
  cli,
  "init",
  "--dir",
  metaHome,
  "--provider",
  "meta",
  "--locale",
  "en",
  "--mode",
  "polling",
], { encoding: "utf8" });
assert.equal(metaInit.status, 0, metaInit.stderr);
const metaEnv = await readFile(join(metaHome, ".env"), "utf8");
assert.match(metaEnv, /CTA_PROVIDER=meta/);
assert.match(metaEnv, /META_APP_SECRET=/);
assert.match(metaEnv, /IG_ACCESS_TOKEN=/);
assert.doesNotMatch(metaEnv, /HOOKMYAPP_CHANNEL_ID=/);
const metaDoctor = spawnSync(process.execPath, [cli, "doctor", "--dir", metaHome], { encoding: "utf8" });
assert.equal(metaDoctor.status, 0, `${metaDoctor.stdout}\n${metaDoctor.stderr}`);

const serverUrl = pathToFileURL(resolve(root, "src/server.mjs")).href;
const boundaryEnv = {
  ...process.env,
  HOST: "0.0.0.0",
  ALLOW_INSECURE_HTTP: "0",
  DRY_RUN: "1",
  VERIFY_TOKEN: "boundary-test",
  ROUTES_FILE: join(home, "routes.json"),
  STATE_FILE: join(home, "state", "boundary-events.jsonl"),
};
const blockedBind = spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `const module = await import(${JSON.stringify(serverUrl)}); module.createServer();`,
], { encoding: "utf8", env: boundaryEnv });
assert.notEqual(blockedBind.status, 0);
assert.match(blockedBind.stderr, /non-loopback HOST requires ALLOW_INSECURE_HTTP=1/);

const allowedBind = spawnSync(process.execPath, [
  "--input-type=module",
  "-e",
  `const module = await import(${JSON.stringify(serverUrl)}); module.createServer();`,
], {
  encoding: "utf8",
  env: { ...boundaryEnv, ALLOW_INSECURE_HTTP: "1" },
});
assert.equal(allowedBind.status, 0, allowedBind.stderr);

console.log("cli.test.mjs passed");
