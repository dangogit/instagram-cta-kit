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

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const events = [
  // canonical comment-flow delivery: dm_sent leg + completed sent event
  { status: "dm_sent", keyword: "GUIDE", media_id: "111", at: iso(60_000) },
  { status: "sent", keyword: "GUIDE", media_id: "111", at: iso(60_000) },
  // second delivery, different post
  { status: "dm_sent", keyword: "GUIDE", media_id: "222", at: iso(2 * 24 * 60 * 60 * 1000) },
  { status: "sent", keyword: "GUIDE", media_id: "222", at: iso(2 * 24 * 60 * 60 * 1000) },
  // message-flow intro is NOT a delivery
  { status: "message_sent", keyword: "GUIDE", funnel_event: "cta_conversation_started", at: iso(30_000) },
  // message-flow guide handoff IS a delivery
  { status: "message_sent", keyword: "OTHER", funnel_event: "cta_guide_delivered", media_id: "333", at: iso(45_000) },
  // follow-gate delivery
  { status: "follow_gate_guide_sent", keyword: "GUIDE", media_id: "111", at: iso(10 * 24 * 60 * 60 * 1000) },
  // story/DM delivery with a synthetic id: counted, but never listed as a post
  { status: "sent", keyword: "OTHER", media_id: "direct-dm:OTHER", at: iso(20_000) },
  // errors and noise
  { status: "dm_error", keyword: "GUIDE", at: iso(5_000) },
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

const { isGuideDelivery, buildSummaryFromEvents } = await import("../src/dashboard.mjs");
const { createServer } = await import("../src/server.mjs");

// --- unit: delivery counting rules ---
assert.equal(isGuideDelivery({ status: "sent", keyword: "X" }), true);
assert.equal(isGuideDelivery({ status: "dm_sent", keyword: "X" }), false, "dm_sent is the DM leg, counting it double-counts");
assert.equal(isGuideDelivery({ status: "sent" }), false, "keyword required");
assert.equal(isGuideDelivery({ status: "message_sent", keyword: "X", funnel_event: "cta_guide_delivered" }), true);
assert.equal(isGuideDelivery({ status: "message_sent", keyword: "X", funnel_event: "cta_conversation_started" }), false);
assert.equal(isGuideDelivery({ status: "message_sent", keyword: "X" }), false);
assert.equal(isGuideDelivery({ status: "follow_gate_guide_sent", keyword: "X" }), true);

// --- unit: aggregation ---
const routes = [
  { keyword: "GUIDE", campaignId: "test-guide", guideUrl: "https://example.com/guide", requiresFollow: true, aliases: [], mediaIds: [] },
  { keyword: "OTHER", campaignId: "test-other", guideUrl: "https://example.com/other", requiresFollow: false, aliases: [], mediaIds: [] },
];
const summary = buildSummaryFromEvents(events, routes, { now: new Date(now) });
assert.equal(summary.totals.delivered_total, 5, "2 comment sends + 1 message handoff + 1 follow-gate + 1 synthetic-id send");
assert.equal(summary.totals.delivered_7d, 4, "the follow-gate delivery is 10 days old");
assert.equal(summary.totals.errors_24h, 1);
assert.equal(summary.totals.active_routes, 2);
assert.equal(summary.daily.length, 14);
assert.equal(summary.daily.at(-1).delivered, 3, "today: GUIDE comment send + OTHER message handoff + OTHER synthetic send");

const guideRoute = summary.routes.find((route) => route.keyword === "GUIDE");
assert.equal(guideRoute.delivered_total, 3);
assert.equal(guideRoute.requires_follow, true);
assert.equal(guideRoute.media[0].media_id, "111", "post 111 has 2 deliveries and ranks first");
assert.equal(guideRoute.media[0].delivered, 2);
const otherRoute = summary.routes.find((route) => route.keyword === "OTHER");
assert.equal(otherRoute.delivered_total, 2, "synthetic-id delivery still counts");
assert.ok(otherRoute.media.every((m) => /^\d+$/.test(m.media_id)), "synthetic ids never listed as posts");

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
