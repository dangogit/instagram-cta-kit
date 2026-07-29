import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-reconciliation-"));
await writeFile(join(tmp, "routes.json"), JSON.stringify({ routes: [] }));

process.env.INSTAGRAM_CTA_HOME = tmp;
process.env.DEFAULT_LOCALE = "en";
process.env.HOST = "127.0.0.1";
process.env.CTA_PROVIDER = "meta";
process.env.VERIFY_TOKEN = randomBytes(16).toString("hex");
process.env.META_APP_SECRET = randomBytes(32).toString("hex");
process.env.IG_USER_ID = "account-1";
process.env.IG_ACCESS_TOKEN = randomBytes(32).toString("hex");
process.env.GRAPH_BASE_URL = "https://graph.invalid/v25.0";
process.env.CTA_ADMIN_TOKEN = randomBytes(32).toString("hex");
process.env.CTA_ATTRIBUTION_SECRET = randomBytes(32).toString("hex");
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = join(tmp, "state", "events.jsonl");
process.env.RECONCILIATION_STATUS_FILE = join(tmp, "state", "reconciliation-status.json");
process.env.DRY_RUN = "0";
process.env.POLL_ENABLED = "0";
process.env.RECONCILE_ENABLED = "1";
process.env.RECONCILE_INTERVAL_MS = "1";
process.env.RECONCILE_RETRY_MS = "1";
process.env.META_REQUEST_TIMEOUT_MS = "25";

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const parsed = new URL(String(url));
  if (parsed.hostname === "graph.invalid") {
    throw new TypeError("simulated provider network failure");
  }
  return nativeFetch(url, options);
};

const { createServer, startReconciliationLoop } = await import("../src/server.mjs");
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const stopReconciliation = startReconciliationLoop();

let health;
const deadline = Date.now() + 2_000;
while (Date.now() < deadline) {
  health = await fetch(`${base}/health`);
  if (health.status === 503) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}

assert.equal(health?.status, 503);
const body = await health.json();
assert.ok(body.issues.includes("reconciliation_failed"));
assert.ok(body.reconciliation_consecutive_failures >= 3);
assert.ok(body.reconciliation_last_attempt_at);
assert.ok(body.reconciliation_last_failure_at);
assert.ok(body.reconciliation_next_run_at);

await stopReconciliation();
const persisted = JSON.parse(await readFile(
  process.env.RECONCILIATION_STATUS_FILE,
  "utf8",
));
assert.ok(persisted.reconciliationConsecutiveFailures >= 3);
assert.ok(persisted.lastReconciliationFailureAt);
server.close();
await once(server, "close");
globalThis.fetch = nativeFetch;
console.log("reconciliation-health.test.mjs passed");
