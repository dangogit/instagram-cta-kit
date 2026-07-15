#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const keywordArg = args.shift();
const guideUrl = args.shift();

function usage() {
  console.error(`Usage:
  npm run add:route -- KEYWORD https://example.com/guides/slug --campaign-id YYYY-MM-DD-asset-slug [--media-id MEDIA_ID]

Options:
  --dm-text TEXT
  --intro-text TEXT
  --guide-text TEXT
  --public-text TEXT
  --non-follower-text TEXT
  --unknown-follower-text TEXT
  --locale en|he
  --campaign-id ID
  --media-id MEDIA_ID
  --media-ids ID1,ID2
  --follow-gate`);
  process.exit(1);
}

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  args.splice(index, 2);
  return value;
}

function hasFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function normalizeKeyword(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeMediaIds(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function routeMediaIds(route) {
  const value = route.media_ids || route.mediaIds || [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function intersects(a, b) {
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

if (!keywordArg || !guideUrl) usage();

const keyword = normalizeKeyword(keywordArg);
if (!/^[A-Z0-9\u0590-\u05ff]{2,30}$/.test(keyword)) throw new Error(`Bad keyword: ${keywordArg}`);
if (!validHttpsUrl(guideUrl)) throw new Error("Guide URL must be a valid https URL without embedded credentials");

const campaignId = String(takeFlag("--campaign-id") || "").trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._-]{1,99}$/.test(campaignId)) throw new Error("--campaign-id is required and must be a stable asset slug");
const locale = String(takeFlag("--locale") || process.env.DEFAULT_LOCALE || "en").toLowerCase();
if (!["en", "he"].includes(locale)) throw new Error("--locale must be en or he");
const defaults = locale === "he" ? {
  intro: `קיבלתי את התגובה על ${keyword}. לשלוח את המדריך?`,
  guide: `הנה המדריך:\n${guideUrl}\n\nאשמח לשמוע אם הוא עזר.`,
  publicReply: "שלחתי לך הודעה בפרטי ✨",
  follow: "כדי לקבל את הלינק, צריך לעקוב אחרי החשבון ואז ללחוץ כאן.",
} : {
  intro: `Thanks for your comment about ${keyword}. Want me to send the guide?`,
  guide: `Here is the guide:\n${guideUrl}\n\nLet me know if it helps.`,
  publicReply: "Sent you a DM ✨",
  follow: "Follow the account, then tap the button below to get the link.",
};
const introText = takeFlag("--intro-text") || defaults.intro;
const dmText = takeFlag("--guide-text") || takeFlag("--dm-text") || defaults.guide;
const publicReplyText = takeFlag("--public-text") || defaults.publicReply;
const nonFollowerText = takeFlag("--non-follower-text") || defaults.follow;
const unknownFollowerText = takeFlag("--unknown-follower-text") || nonFollowerText;
const mediaIds = [
  ...normalizeMediaIds(takeFlag("--media-ids")),
  ...normalizeMediaIds(takeFlag("--media-id")),
];
const followGate = hasFlag("--follow-gate");
if (args.length) usage();

const routesFile = resolve(process.cwd(), process.env.ROUTES_FILE || "./routes.json");
const raw = await readFile(routesFile, "utf8");
const parsed = JSON.parse(raw);
if (!Array.isArray(parsed.routes)) parsed.routes = [];

for (const route of parsed.routes) {
  if (route.active === false) continue;
  const existingKeywords = [route.keyword, ...(route.aliases || [])].map(normalizeKeyword);
  if (!existingKeywords.includes(keyword)) continue;
  const existingMediaIds = routeMediaIds(route);
  if (existingMediaIds.length === 0 || mediaIds.length === 0 || intersects(existingMediaIds, mediaIds)) {
    throw new Error(`${keyword} already exists. Use media_ids only for non-overlapping post-specific routes.`);
  }
}

const route = {
  keyword,
  campaign_id: campaignId,
  guide_url: guideUrl,
  intro_text: introText,
  reply_text: dmText,
  public_reply_text: publicReplyText,
};

if (followGate) {
  route.requires_follow = true;
  route.non_follower_text = nonFollowerText;
  route.unknown_follower_text = unknownFollowerText;
}

if (mediaIds.length) route.media_ids = mediaIds;

parsed.routes.push(route);
await writeFile(routesFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
console.log(`added ${keyword} -> ${guideUrl}`);
