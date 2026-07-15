import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = resolve(root, "bin/instagram-cta.mjs");
const home = await mkdtemp(join(tmpdir(), "instagram-cta-cli-"));

const init = spawnSync(process.execPath, [cli, "init", "--dir", home, "--locale", "he", "--mode", "polling"], { encoding: "utf8" });
assert.equal(init.status, 0, init.stderr);

const env = await readFile(join(home, ".env"), "utf8");
assert.match(env, /DEFAULT_LOCALE=he/);
assert.match(env, /POLL_ENABLED=1/);
assert.match(env, /DRY_RUN=1/);
assert.doesNotMatch(env, /replace-with-a-random-webhook-verify-token/);

const routes = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
assert.equal(routes.routes.length, 2);

const doctor = spawnSync(process.execPath, [cli, "doctor", "--dir", home], { encoding: "utf8" });
assert.equal(doctor.status, 0, `${doctor.stdout}\n${doctor.stderr}`);
assert.match(doctor.stdout, /route validation: passed/);

const add = spawnSync(process.execPath, [
  cli,
  "route",
  "add",
  "TEST",
  "https://example.com/test",
  "--dir",
  home,
  "--campaign-id",
  "test-guide",
  "--locale",
  "en",
], { encoding: "utf8" });
assert.equal(add.status, 0, add.stderr);

const updated = JSON.parse(await readFile(join(home, "routes.json"), "utf8"));
const added = updated.routes.find((route) => route.keyword === "TEST");
assert.equal(added.campaign_id, "test-guide");
assert.equal(added.requires_follow, undefined);
assert.match(added.reply_text, /https:\/\/example\.com\/test/);

console.log("cli.test.mjs passed");
