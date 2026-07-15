import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const routesFile = resolve(process.cwd(), process.env.ROUTES_FILE || "./routes.json");
const raw = await readFile(routesFile, "utf8");
const parsed = JSON.parse(raw);
const routes = (Array.isArray(parsed.routes) ? parsed.routes : []).filter((route) => route.active !== false);
const errors = [];
const warnings = [];

function normalizeKeyword(value) {
  return String(value || "").trim().toUpperCase();
}

function mediaIds(route) {
  const value = route.media_ids || route.mediaIds || [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function intersects(a, b) {
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

function keywords(route) {
  return [route.keyword, ...(route.aliases || [])].map(normalizeKeyword).filter(Boolean);
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

for (const [index, route] of routes.entries()) {
  const keyword = normalizeKeyword(route.keyword);
  if (!/^[A-Z0-9֐-׿]{2,30}$/.test(keyword)) errors.push(`routes[${index}] bad keyword: ${route.keyword}`);
  const legacyRoute = !route.campaign_id;
  if (legacyRoute) {
    warnings.push(`${keyword} is a legacy route without campaign_id; migrate it before editing`);
  } else if (!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(route.campaign_id)) {
    errors.push(`${keyword} campaign_id must be a stable asset slug`);
  }
  for (const alias of route.aliases || []) {
    const normalizedAlias = normalizeKeyword(alias);
    if (!/^[A-Z0-9֐-׿]{2,30}$/.test(normalizedAlias)) errors.push(`${keyword} bad alias: ${alias}`);
  }
  if (!validHttpsUrl(route.guide_url)) errors.push(`${keyword} guide_url must be a valid https URL without embedded credentials`);
  if (!String(route.reply_text || "").includes(route.guide_url || "__missing__")) {
    if (legacyRoute) warnings.push(`${keyword} legacy reply_text has no attributable guide URL`);
    else errors.push(`${keyword} reply_text must contain guide_url for attribution replacement`);
  }
  if (route.intro_text !== undefined && !String(route.intro_text).trim()) errors.push(`${keyword} intro_text must not be empty when present`);
  if (route.guide_text !== undefined && !String(route.guide_text).trim()) errors.push(`${keyword} guide_text must not be empty when present`);
  if (!String(route.reply_text || "").trim()) errors.push(`${keyword} reply_text is required`);
  if (route.requires_follow === true && !String(route.non_follower_text || "").trim()) {
    errors.push(`${keyword} non_follower_text is required when requires_follow is true`);
  }
  if (route.requires_follow === true && route.unknown_follower_text !== undefined && !String(route.unknown_follower_text).trim()) {
    errors.push(`${keyword} unknown_follower_text must not be empty when present`);
  }
  const publicReply = route.public_reply_text;
  if (publicReply !== undefined && publicReply !== false && !String(publicReply).trim()) errors.push(`${keyword} public_reply_text must not be empty`);
}

for (let i = 0; i < routes.length; i += 1) {
  const a = routes[i];
  const ka = normalizeKeyword(a.keyword);
  const keywordsA = keywords(a);
  const mediaA = mediaIds(a);
  for (let j = i + 1; j < routes.length; j += 1) {
    const b = routes[j];
    const kb = normalizeKeyword(b.keyword);
    const keywordsB = keywords(b);
    const mediaB = mediaIds(b);
    const collisions = keywordsA.filter((keyword) => keywordsB.includes(keyword));
    if (collisions.length && (mediaA.length === 0 || mediaB.length === 0 || intersects(mediaA, mediaB))) {
      errors.push(`${ka}/${kb} duplicate keyword or alias (${collisions.join(", ")}) needs non-overlapping media_ids`);
    }
    if (ka !== kb && (ka.includes(kb) || kb.includes(ka))) {
      warnings.push(`${ka} overlaps ${kb} by substring, exact token matcher required`);
    }
  }
}

if (process.env.CHECK_GUIDES === "1") {
  for (const route of routes) {
    const keyword = normalizeKeyword(route.keyword);
    let response = await fetch(route.guide_url, {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 405) {
      response = await fetch(route.guide_url, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      await response.body?.cancel();
    }
    if (!response.ok) errors.push(`${keyword} guide_url returned ${response.status}`);
  }
}

assert.equal(errors.length, 0, errors.join("\n"));
for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`routes ok: ${routes.length}`);
