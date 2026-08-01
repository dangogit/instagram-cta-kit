import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-dashboard-"));
const adminToken = randomBytes(32).toString("hex");

await writeFile(join(tmp, "routes.json"), JSON.stringify({
  routes: [
    {
      keyword: "GUIDE",
      campaign_id: "test-guide",
      guide_url: "https://example.com/guide",
      reply_text: "here you go",
      requires_follow: true,
    },
    {
      keyword: "OTHER",
      campaign_id: "test-other",
      guide_url: "https://example.com/other",
      reply_text: "other guide",
    },
  ],
}));

// Fixture mirrors what the pipeline actually writes across both eras:
// - legacy (pre ask-first): dm_sent + sent, no funnel_event anywhere = 1 delivery
// - modern intro: dm_sent(cta_conversation_started) + sent completion = 0 deliveries
// - modern handoffs carry funnel_event cta_guide_delivered exactly once each
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const events = [
  // legacy comment delivery (counted once, via the "sent" completion)
  { status: "dm_sent", keyword: "GUIDE", comment_id: "c-legacy", media_id: "111", at: iso(60_000) },
  { status: "sent", keyword: "GUIDE", comment_id: "c-legacy", media_id: "111", at: iso(60_000) },
  // modern ask-first intro: NOT a delivery, shows as a conversation
  { status: "dm_sent", keyword: "GUIDE", comment_id: "c-intro", funnel_event: "cta_conversation_started", at: iso(30_000) },
  { status: "sent", keyword: "GUIDE", comment_id: "c-intro", at: iso(30_000) },
  // modern direct delivery: dm carries the marker, "sent" completion must not double it
  { status: "dm_sent", keyword: "GUIDE", comment_id: "c-direct", funnel_event: "cta_guide_delivered", media_id: "222", at: iso(45_000) },
  { status: "sent", keyword: "GUIDE", comment_id: "c-direct", media_id: "222", at: iso(45_000) },
  // modern message-flow handoff
  { status: "message_sent", keyword: "OTHER", funnel_event: "cta_guide_delivered", media_id: "333", at: iso(20_000) },
  // modern message-flow intro reply (funnel null): not a delivery
  { status: "message_sent", keyword: "OTHER", funnel_event: null, at: iso(15_000) },
  // legacy follow-gate delivery, 10 days old
  { status: "follow_gate_guide_sent", keyword: "GUIDE", media_id: "111", at: iso(10 * 24 * 60 * 60 * 1000) },
  // story/DM delivery with a synthetic id: counted, but never listed as a post
  { status: "message_sent", keyword: "OTHER", funnel_event: "cta_guide_delivered", media_id: "direct-dm:OTHER", at: iso(10_000) },
  // errors: one real, one manual replay (excluded like /health does)
  { status: "dm_error", keyword: "GUIDE", at: iso(5_000) },
  { status: "dm_error", keyword: "GUIDE", message_id: "manual-replay-abc", at: iso(5_000) },
  // noise
  { status: "message_ignored", at: iso(4_000) },
  { status: "sent", at: iso(3_000) }, // no keyword: never counted
];
await mkdir(join(tmp, "state"), { recursive: true });
await writeFile(
  join(tmp, "state", "events.jsonl"),
  events.map((event) => JSON.stringify(event)).join("\n") + "\n",
);

process.env.INSTAGRAM_CTA_HOME = tmp;
process.env.DEFAULT_LOCALE = "he";
process.env.HOST = "127.0.0.1";
process.env.CTA_PROVIDER = "meta";
process.env.VERIFY_TOKEN = randomBytes(16).toString("hex");
process.env.META_APP_SECRET = randomBytes(32).toString("hex");
process.env.IG_USER_ID = "account-1";
process.env.IG_ACCESS_TOKEN = randomBytes(32).toString("hex");
process.env.GRAPH_BASE_URL = "https://graph.invalid/v25.0";
process.env.CTA_ADMIN_TOKEN = adminToken;
process.env.CTA_ATTRIBUTION_SECRET = randomBytes(32).toString("hex");
process.env.ROUTES_FILE = join(tmp, "routes.json");
process.env.STATE_FILE = join(tmp, "state", "events.jsonl");
process.env.DRY_RUN = "0";
process.env.POLL_ENABLED = "0";
process.env.RECONCILE_ENABLED = "0";

let graphCalls = 0;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const parsed = new URL(String(url));
  if (parsed.hostname === "graph.invalid") {
    graphCalls += 1;
    return new Response(JSON.stringify({
      id: parsed.pathname.split("/").pop(),
      caption: "New post about GUIDE automation",
      media_type: "IMAGE",
      media_url: "https://cdn.example.com/img.jpg",
      permalink: "https://www.instagram.com/p/TEST/",
      timestamp: new Date().toISOString(),
      like_count: 42,
      comments_count: 7,
      username: "testuser",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return nativeFetch(url, options);
};

const { buildDeliveryClassifier, buildSummaryFromEvents } = await import("../src/dashboard.mjs");
const { createServer } = await import("../src/server.mjs");

// --- unit: delivery counting rules ---
const isDelivery = buildDeliveryClassifier(events);
assert.equal(isDelivery({ status: "sent", keyword: "X" }), true, "legacy sent with no funnel anywhere is a delivery");
assert.equal(isDelivery(events[1]), true, "legacy sent counts");
assert.equal(isDelivery(events[0]), false, "legacy dm_sent is the DM leg, not the completion");
assert.equal(isDelivery(events[2]), false, "intro dm_sent is a conversation, not a delivery");
assert.equal(isDelivery(events[3]), false, "sent completion of an intro comment must not count");
assert.equal(isDelivery(events[4]), true, "direct dm_sent with cta_guide_delivered counts");
assert.equal(isDelivery(events[5]), false, "sent completion of a marker-carrying comment must not double-count");
assert.equal(isDelivery(events[6]), true, "message handoff counts");
assert.equal(isDelivery(events[7]), false, "message_sent with funnel null is not a delivery");
assert.equal(isDelivery(events[8]), true, "legacy follow-gate delivery counts");
assert.equal(isDelivery({ status: "sent" }), false, "keyword required");

// --- unit: aggregation ---
const routes = [
  { keyword: "GUIDE", campaignId: "test-guide", guideUrl: "https://example.com/guide", requiresFollow: true, aliases: [], mediaIds: [] },
  { keyword: "OTHER", campaignId: "test-other", guideUrl: "https://example.com/other", requiresFollow: false, aliases: [], mediaIds: [] },
];
const summary = buildSummaryFromEvents(events, routes, { now: new Date(now) });
assert.equal(summary.totals.delivered_total, 5, "legacy sent + direct dm + message handoff + follow-gate + synthetic");
assert.equal(summary.totals.delivered_7d, 4, "the follow-gate delivery is 10 days old");
assert.equal(summary.totals.errors_24h, 1, "manual-replay errors excluded");
assert.equal(summary.totals.active_routes, 2);
assert.equal(summary.daily.length, 14);
assert.equal(summary.daily.at(-1).delivered, 4, "today: all but the 10-day-old follow-gate");

const guideRoute = summary.routes.find((route) => route.keyword === "GUIDE");
assert.equal(guideRoute.delivered_total, 3, "legacy + direct + follow-gate");
assert.equal(guideRoute.requires_follow, true);
assert.equal(guideRoute.media[0].media_id, "111", "post 111 has 2 deliveries and ranks first");
assert.equal(guideRoute.media[0].delivered, 2);
const otherRoute = summary.routes.find((route) => route.keyword === "OTHER");
assert.equal(otherRoute.delivered_total, 2, "synthetic-id delivery still counts");
assert.ok(otherRoute.media.every((m) => /^\d+$/.test(m.media_id)), "synthetic ids never listed as posts");

const kinds = summary.recent.map((e) => e.kind);
assert.ok(kinds.includes("delivery") && kinds.includes("conversation") && kinds.includes("error"));
assert.equal(summary.recent.filter((e) => e.kind === "delivery").length, 5, "feed deliveries match the KPI");

// --- integration: auth gate ---
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

const unauthorized = await nativeFetch(`${base}/dashboard`);
assert.equal(unauthorized.status, 401);
const unauthorizedApi = await nativeFetch(`${base}/dashboard/api/summary`);
assert.equal(unauthorizedApi.status, 401);

const tokenLanding = await nativeFetch(`${base}/dashboard?token=${adminToken}`, { redirect: "manual" });
assert.equal(tokenLanding.status, 302, "valid token sets cookie and cleans the URL");
const setCookie = tokenLanding.headers.get("set-cookie") || "";
assert.match(setCookie, /cta_dashboard=/);
assert.match(setCookie, /HttpOnly/);
assert.ok(!setCookie.includes(adminToken), "cookie must hold a derived value, not the admin token itself");

const cookie = setCookie.split(";")[0];
const page = await nativeFetch(`${base}/dashboard`, { headers: { cookie } });
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /dir="rtl"/, "Hebrew locale renders RTL");
assert.match(html, /דשבורד CTA/);
// the inline script is authored inside a server-side template literal, where a
// single backslash silently disappears - make sure what ships actually parses
const inlineScript = html.match(/<script>([\s\S]*)<\/script>/);
assert.ok(inlineScript, "page has an inline script");
assert.doesNotThrow(() => new Function(inlineScript[1]), "inline script parses as valid JS");

const wrongToken = await nativeFetch(`${base}/dashboard?token=${randomBytes(32).toString("hex")}`, { redirect: "manual" });
assert.equal(wrongToken.status, 401);
const brokenCookie = await nativeFetch(`${base}/dashboard`, { headers: { cookie: "cta_dashboard=%zz" } });
assert.equal(brokenCookie.status, 401, "malformed cookie is a 401, not a 500");

// --- integration: summary endpoint ---
const apiRes = await nativeFetch(`${base}/dashboard/api/summary`, {
  headers: { Authorization: `Bearer ${adminToken}` },
});
assert.equal(apiRes.status, 200);
const api = await apiRes.json();
assert.equal(api.ok, true);
assert.equal(api.totals.delivered_total, 5);
assert.equal(api.service.provider, "meta");
assert.equal(api.service.locale, "he");
assert.equal(api.routes[0].keyword, "GUIDE", "sorted by deliveries");

// --- integration: media metadata with disk cache ---
const mediaRes = await nativeFetch(`${base}/dashboard/api/media/111`, { headers: { cookie } });
assert.equal(mediaRes.status, 200);
const media = (await mediaRes.json()).media;
assert.equal(media.username, "testuser");
assert.equal(media.like_count, 42);
assert.equal(graphCalls, 1);

await nativeFetch(`${base}/dashboard/api/media/111`, { headers: { cookie } });
assert.equal(graphCalls, 1, "second request is served from cache");
const cacheRaw = JSON.parse(await readFile(join(tmp, "state", "media-cache.json"), "utf8"));
assert.ok(cacheRaw["111"], "cache persisted to disk");

const badMedia = await nativeFetch(`${base}/dashboard/api/media/notanumber`, { headers: { cookie } });
assert.equal(badMedia.status, 404);

server.close();
console.log("dashboard.test.mjs passed");
