import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const homeDir = resolve(process.env.INSTAGRAM_CTA_HOME || process.cwd());
const locale = process.env.DEFAULT_LOCALE === "he" ? "he" : "en";
const copy = {
  en: {
    publicReply: "Sent you a DM ✨",
    intro: (keyword) => `Thanks for your comment about ${keyword}. Want me to send the guide?`,
    wantsGuide: "Yes, send it",
    followed: "I followed",
    moreGuides: "More guides",
    question: "I have a question",
    done: "Done",
    followFirst: "Follow the account, then tap the button below to get the link.",
    moreGuidesMessage: "Reply to a post or Story with one of the configured guide keywords.",
    questionMessage: "Write what you are trying to build and I will reply here.",
    doneMessage: "Great. Save the guide and come back to it while you build.",
  },
  he: {
    publicReply: "שלחתי לך הודעה בפרטי ✨",
    intro: (keyword) => `קיבלתי את התגובה על ${keyword}. לשלוח את המדריך?`,
    wantsGuide: "כן, אפשר לשלוח",
    followed: "התחלתי לעקוב",
    moreGuides: "עוד מדריך",
    question: "יש לי שאלה",
    done: "סיימתי",
    followFirst: "כדי לקבל את הלינק, צריך לעקוב אחרי החשבון ואז ללחוץ כאן.",
    moreGuidesMessage: "אפשר להגיב לפוסט או לסטורי עם אחת ממילות המפתח שהוגדרו.",
    questionMessage: "אפשר לכתוב כאן מה מנסים לבנות, ואענה.",
    doneMessage: "מעולה. כדאי לשמור את המדריך ולחזור אליו בזמן הבנייה.",
  },
}[locale];

const env = {
  port: Number(process.env.PORT || 18787),
  host: process.env.HOST || "127.0.0.1",
  verifyToken: process.env.VERIFY_TOKEN || "",
  appSecret: process.env.META_APP_SECRET || "",
  igUserId: process.env.IG_USER_ID || "",
  accessToken: process.env.IG_ACCESS_TOKEN || "",
  graphBaseUrl: process.env.GRAPH_BASE_URL || "https://graph.instagram.com/v25.0",
  routesFile: resolve(homeDir, process.env.ROUTES_FILE || "./routes.json"),
  stateFile: resolve(homeDir, process.env.STATE_FILE || "./state/events.jsonl"),
  webhookLogFile: resolve(homeDir, process.env.WEBHOOK_LOG_FILE || "./state/webhooks.jsonl"),
  dryRun: process.env.DRY_RUN === "1",
  defaultPublicReplyText: process.env.DEFAULT_PUBLIC_REPLY_TEXT || copy.publicReply,
  logWebhookContent: process.env.LOG_WEBHOOK_CONTENT === "1",
  pollEnabled: process.env.POLL_ENABLED === "1",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60000),
  pollMediaLimit: Number(process.env.POLL_MEDIA_LIMIT || 100),
  pollCommentsLimit: Number(process.env.POLL_COMMENTS_LIMIT || 100),
  pollConversationLimit: Number(process.env.POLL_CONVERSATION_LIMIT || 25),
  pollMessagesLimit: Number(process.env.POLL_MESSAGES_LIMIT || 10),
  pollMaxCommentPages: Number(process.env.POLL_MAX_COMMENT_PAGES || 20),
  pollMaxConversationPages: Number(process.env.POLL_MAX_CONVERSATION_PAGES || 20),
  pollMaxMessagePages: Number(process.env.POLL_MAX_MESSAGE_PAGES || 20),
  initialPollSinceIso: process.env.POLL_SINCE_ISO || new Date().toISOString(),
  pollCursorFile: resolve(homeDir, process.env.POLL_CURSOR_FILE || "./state/poll-cursor.json"),
  messagePollCursorFile: resolve(homeDir, process.env.POLL_MESSAGE_CURSOR_FILE || "./state/message-poll-cursor.json"),
  followGateEnabled: process.env.FOLLOW_GATE_GUIDE_ENABLED === "1",
  followGateIntervalMs: Number(process.env.FOLLOW_GATE_INTERVAL_MS || 600000),
  followGateMaxAgeDays: Number(process.env.FOLLOW_GATE_MAX_AGE_DAYS || 14),
  attributionSecret: process.env.CTA_ATTRIBUTION_SECRET || (process.env.DRY_RUN === "1" ? "dry-run-attribution-secret" : ""),
  posthogToken: process.env.POSTHOG_PROJECT_TOKEN || "",
  posthogHost: process.env.POSTHOG_HOST || "",
};

const pollStatus = {
  lastRunAt: null,
  lastError: null,
  sinceIso: env.initialPollSinceIso,
  mediaCount: 0,
  commentCount: 0,
  messageCount: 0,
  resultCount: 0,
  followGateResultCount: 0,
};

function assertConfig() {
  const missing = [];
  if (!env.verifyToken) missing.push("VERIFY_TOKEN");
  if (!env.appSecret && !env.dryRun) missing.push("META_APP_SECRET");
  if (!env.igUserId && !env.dryRun) missing.push("IG_USER_ID");
  if (!env.accessToken && !env.dryRun) missing.push("IG_ACCESS_TOKEN");
  if (!env.attributionSecret && !env.dryRun) missing.push("CTA_ATTRIBUTION_SECRET");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
}

async function loadRoutes() {
  const raw = await readFile(env.routesFile, "utf8");
  const parsed = JSON.parse(raw);
  const routes = Array.isArray(parsed.routes) ? parsed.routes : [];
  return routes.map((route) => ({
    keyword: String(route.keyword || "").trim().toUpperCase(),
    campaignId: String(route.campaign_id || route.campaignId || `legacy-${String(route.keyword || "unknown").toLowerCase()}`).trim().toLowerCase(),
    guideUrl: route.guide_url || route.guideUrl || "",
    replyText: route.reply_text || route.replyText || "",
    guideText: route.guide_text || route.guideText || route.reply_text || route.replyText || "",
    introText: route.intro_text || route.introText || "",
    publicReplyText: route.public_reply_text || route.publicReplyText || env.defaultPublicReplyText,
    nonFollowerText: route.non_follower_text || route.nonFollowerText || "",
    unknownFollowerText: route.unknown_follower_text || route.unknownFollowerText || "",
    aliases: normalizeList(route.aliases).map((alias) => alias.toUpperCase()),
    requiresFollow: route.requires_follow === true || route.requiresFollow === true,
    mediaIds: normalizeList(route.media_ids || route.mediaIds),
    active: route.active !== false,
  })).filter((route) => route.active && route.keyword && route.replyText);
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(body, header) {
  if (env.dryRun) return true;
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(header.slice("sha256=".length), "hex");
  const actual = Buffer.from(createHmac("sha256", env.appSecret).update(body).digest("hex"), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function extractComments(payload) {
  const comments = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      const value = change.value || {};
      const commentId = value.comment_id || value.id;
      const text = value.text || value.message || "";
      const mediaId = value.media_id || value.media?.id || null;
      if (!commentId || !text) continue;
      comments.push({
        igUserId: entry.id || env.igUserId,
        commentId: String(commentId),
        mediaId,
        text: String(text),
        fromId: value.from?.id || null,
        followerState: inferFollowerState(value),
        raw: value,
      });
    }
  }
  return comments;
}

function extractMessages(payload) {
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const item of entry.messaging || []) {
      const senderId = item.sender?.id;
      const message = item.message || {};
      const postback = item.postback || {};
      const text = message.text || postback.title || "";
      const quickReplyPayload = message.quick_reply?.payload || postback.payload || "";
      const story = message.reply_to?.story || item.reply_to?.story || null;
      if (!senderId || (!text && !quickReplyPayload)) continue;
      messages.push({
        igUserId: entry.id || item.recipient?.id || env.igUserId,
        senderId: String(senderId),
        messageId: String(message.mid || postback.mid || `${senderId}:${item.timestamp || ""}:${quickReplyPayload || text}`),
        text: String(text || ""),
        payload: String(quickReplyPayload || ""),
        storyId: story?.id ? String(story.id) : null,
        storyUrl: story?.url ? String(story.url) : null,
        raw: item,
      });
    }
  }
  return messages;
}

function inferFollowerState(value) {
  const candidates = [
    value.is_follower,
    value.isFollower,
    value.follows_business,
    value.followsBusiness,
    value.from?.is_follower,
    value.from?.isFollower,
    value.from?.follows_business,
    value.from?.followsBusiness,
  ];
  for (const candidate of candidates) {
    if (candidate === true) return true;
    if (candidate === false) return false;
  }
  return null;
}

// Keyword tokens may be Latin (DESIGN, WATCH) or Hebrew (פידבק). The Hebrew block
// (U+0590–U+05FF) must be included or Hebrew keywords get stripped and never match.
const KEYWORD_TOKEN_RE = /[A-Z0-9֐-׿]+/g;

function keywordTokens(text) {
  return String(text || "").toUpperCase().match(KEYWORD_TOKEN_RE) || [];
}

function matchRoute(text, routes) {
  const tokens = keywordTokens(text);
  const exact = routes.find((route) => routeKeywords(route).some((keyword) => tokens.includes(keyword)));
  return exact || matchRouteTypo(tokens, routes);
}

function routeKeywords(route) {
  return [route.keyword, ...(route.aliases || [])];
}

function matchRouteTypo(tokens, routes) {
  const matches = [];
  for (const route of routes) {
    let best = Infinity;
    for (const token of tokens) {
      if (token.length < 4) continue;
      for (const keyword of routeKeywords(route)) {
        if (keyword.length < 4 || Math.abs(token.length - keyword.length) > 1) continue;
        const distance = damerauLevenshtein(token, keyword);
        if (distance > 0 && distance <= 1) best = Math.min(best, distance);
      }
    }
    if (Number.isFinite(best)) matches.push({ route, distance: best });
  }
  matches.sort((a, b) => a.distance - b.distance);
  if (!matches.length) return null;
  if (matches[1]?.distance === matches[0].distance) return null;
  return matches[0].route;
}

function damerauLevenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[a.length][b.length];
}

function quickReply(title, payload) {
  return { content_type: "text", title, payload };
}

function quickReplyPayload(action, route, mediaId = "") {
  return [action, route.keyword, mediaId || ""].join("|");
}

function parseQuickReplyPayload(payload) {
  const [action, keyword, mediaId] = String(payload || "").split("|");
  return {
    action,
    keyword: String(keyword || "").trim().toUpperCase(),
    mediaId: mediaId || null,
  };
}

function ctaQuickReplies(route, comment) {
  if (route.requiresFollow && comment.followerState !== true) {
    return [
      quickReply(copy.followed, quickReplyPayload("CTA_FOLLOWED", route, comment.mediaId)),
    ];
  }
  return [
    quickReply(copy.moreGuides, "CTA_MORE_GUIDES"),
    quickReply(copy.question, "CTA_QUESTION"),
    quickReply(copy.done, "CTA_DONE"),
  ];
}

function introQuickReplies(route, comment) {
  return [
    quickReply(copy.wantsGuide, quickReplyPayload("CTA_WANTS_GUIDE", route, comment.mediaId)),
  ];
}

function isFollowUpText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return false;
  const stripped = normalized.replace(/[!?.،,]+$/g, "").trim();
  if (/^(yes|yep|yeah|כן+|כן+\s*,?\s*שלח(?:י)?(?:\s+לי)?|כן+\s+אפשר|כן+\s+תודה)$/i.test(stripped)) {
    return true;
  }
  return [
    "followed",
    "i followed",
    "done",
    "send",
    "send it",
    "send me",
    "עקבתי",
    "עוקב",
    "עשיתי פולו",
    "שלח",
    "שלחי",
    "שלח לי",
    "שלחי לי",
    "אפשר",
  ].some((phrase) => normalized.includes(phrase));
}

function routeMatchesComment(route, comment) {
  return route.mediaIds.length === 0 || route.mediaIds.includes(comment.mediaId);
}

function pendingKey(commentOrEvent) {
  const fromId = commentOrEvent.fromId || commentOrEvent.from_id;
  const mediaId = commentOrEvent.mediaId || commentOrEvent.media_id;
  if (!fromId || !mediaId) return null;
  return `${fromId}:${mediaId}`;
}

function findFollowUpRoute(comment, routes, pendingFollowUps) {
  if (!isFollowUpText(comment.text)) return null;
  const pending = pendingFollowUps.get(pendingKey(comment));
  if (!pending) return null;
  return routes.find((route) => route.keyword === pending.keyword) || null;
}

function findLatestFollowUpRoute(message, routes, pendingFollowUpsByUser) {
  if (!isFollowUpText(message.text)) return null;
  const pending = pendingFollowUpsByUser.get(message.senderId);
  if (!pending) return null;
  const route = routes.find((candidate) => candidate.keyword === pending.keyword);
  return route ? { route, mediaId: pending.mediaId } : null;
}

function findKnownCommentRoute(comment, routes, knownCommentRoutes) {
  const keyword = knownCommentRoutes.get(comment.commentId);
  if (!keyword) return null;
  return routes.find((route) => route.keyword === keyword) || null;
}

function updatePendingFollowUps(pendingFollowUps, comment, route) {
  const key = pendingKey(comment);
  if (!key || !route.requiresFollow) return;
  if (comment.followerState === true) {
    pendingFollowUps.delete(key);
    return;
  }
  pendingFollowUps.set(key, { keyword: route.keyword });
}

function buildIntroReply(route) {
  return route.introText || copy.intro(route.keyword);
}

function deliveryAttribution(route, comment) {
  const contentId = String(comment.mediaId || comment.media_id || `direct-dm:${route.keyword}`);
  const recipientKey = String(comment.fromId || comment.from_id || comment.commentId || comment.comment_id || "unknown");
  const deliveryId = createHmac("sha256", env.attributionSecret)
    .update([recipientKey, contentId, route.keyword].join(":"))
    .digest("base64url")
    .slice(0, 32);
  let destinationHost = "unknown";
  try {
    destinationHost = new URL(route.guideUrl).host;
  } catch {}
  return {
    campaign_id: route.campaignId,
    content_id: contentId,
    delivery_id: deliveryId,
    destination_host: destinationHost,
  };
}

function attributedGuideUrl(route, delivery) {
  let url;
  try {
    url = new URL(route.guideUrl);
  } catch {
    return route.guideUrl || "";
  }
  url.searchParams.set("utm_source", "instagram");
  url.searchParams.set("utm_medium", "dm");
  url.searchParams.set("utm_campaign", delivery.campaign_id);
  url.searchParams.set("utm_content", delivery.content_id);
  url.searchParams.set("cta", route.keyword);
  url.searchParams.set("delivery_id", delivery.delivery_id);
  return url.toString();
}

function buildReply(route, comment, delivery = null) {
  if (route.requiresFollow && comment.followerState !== true) {
    return route.nonFollowerText || copy.followFirst;
  }
  const text = route.guideText || route.replyText;
  if (!route.guideUrl) return text;
  const attribution = delivery || deliveryAttribution(route, comment);
  return text.split(route.guideUrl).join(attributedGuideUrl(route, attribution));
}

async function lookupFollowerState(comment) {
  if (comment.followerState !== null) return comment.followerState;
  if (!comment.fromId || env.dryRun) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const url = new URL(`${env.graphBaseUrl}/${encodeURIComponent(comment.fromId)}`);
      url.searchParams.set("fields", "is_user_follow_business");
      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${env.accessToken}`,
        },
      });
      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = { raw: responseText };
      }
      if (response.ok) {
        return typeof data.is_user_follow_business === "boolean" ? data.is_user_follow_business : null;
      }
      if (response.status < 500) return null;
    } catch {
      // Retry transient network and Meta 5xx failures. Null keeps follow gate closed.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  return null;
}

async function resolveFollowerState(route, comment) {
  if (!route.requiresFollow) return comment;
  const followerState = await lookupFollowerState(comment);
  return { ...comment, followerState };
}

async function sendMessageBody(url, body, fallbackBody = null) {
  if (env.dryRun) {
    return { dry_run: true, url, body };
  }
  const send = async (requestBody) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { raw: responseText };
    }
    return { ok: response.ok, status: response.status, data };
  };
  const primary = await send(body);
  if (primary.ok) return primary.data;
  if (fallbackBody && primary.status >= 400 && primary.status < 500) {
    const fallback = await send(fallbackBody);
    if (fallback.ok) {
      return {
        ...fallback.data,
        quick_replies_fallback: true,
        primary_error: primary.data,
      };
    }
    throw new Error(`Meta message failed ${primary.status}: ${JSON.stringify(primary.data)}; fallback failed ${fallback.status}: ${JSON.stringify(fallback.data)}`);
  }
  throw new Error(`Meta message failed ${primary.status}: ${JSON.stringify(primary.data)}`);
}

async function sendPrivateReply(comment, text, quickReplies = []) {
  const url = `${env.graphBaseUrl}/${encodeURIComponent(comment.igUserId || env.igUserId)}/messages`;
  const message = { text };
  if (quickReplies.length) message.quick_replies = quickReplies;
  const body = {
    recipient: { comment_id: comment.commentId },
    message,
  };
  const fallbackBody = quickReplies.length ? {
    recipient: { comment_id: comment.commentId },
    message: { text },
  } : null;
  return sendMessageBody(url, body, fallbackBody);
}

async function sendDirectMessage(igUserId, recipientId, text, quickReplies = []) {
  const url = `${env.graphBaseUrl}/${encodeURIComponent(igUserId || env.igUserId)}/messages`;
  const message = { text };
  if (quickReplies.length) message.quick_replies = quickReplies;
  const body = {
    recipient: { id: recipientId },
    message,
  };
  const fallbackBody = quickReplies.length ? {
    recipient: { id: recipientId },
    message: { text },
  } : null;
  return sendMessageBody(url, body, fallbackBody);
}

async function sendPublicCommentReply(comment, text) {
  if (!text) return { skipped: true };
  const url = `${env.graphBaseUrl}/${encodeURIComponent(comment.commentId)}/replies`;
  const body = { message: text };
  if (env.dryRun) {
    return { dry_run: true, url, body };
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    data = { raw: responseText };
  }
  if (!response.ok) {
    throw new Error(`Meta comment reply failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function recordEvent(event) {
  await mkdir(dirname(env.stateFile), { recursive: true });
  const recorded = { ...event, at: new Date().toISOString() };
  await appendFile(env.stateFile, `${JSON.stringify(recorded)}\n`);
  if (event.funnel_event) await capturePosthogEvent(event.funnel_event, recorded);
}

async function capturePosthogEvent(eventName, event) {
  if (!env.posthogToken || !env.posthogHost || !event.delivery_id) return false;
  try {
    const response = await fetch(`${env.posthogHost.replace(/\/$/, "")}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.posthogToken,
        event: eventName,
        properties: {
          distinct_id: event.delivery_id,
          $insert_id: `${eventName}-${event.delivery_id}`,
          server_authoritative: true,
          cta_keyword: event.keyword,
          campaign_id: event.campaign_id,
          content_id: event.content_id,
          delivery_id: event.delivery_id,
          destination_host: event.destination_host,
          delivery_status: event.status,
          utm_source: "instagram",
          utm_medium: "dm",
        },
      }),
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function recordWebhookReceipt(payload, comments, messages) {
  const changeFields = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field) changeFields.push(change.field);
    }
  }
  await mkdir(dirname(env.webhookLogFile), { recursive: true });
  const content = env.logWebhookContent ? {
    comments: comments.map((comment) => ({
      comment_id: comment.commentId,
      media_id: comment.mediaId,
      from_tail: comment.fromId ? String(comment.fromId).slice(-6) : null,
      text: comment.text,
    })),
    messages: messages.map((message) => ({
      message_id: message.messageId,
      sender_tail: String(message.senderId).slice(-6),
      text: message.text,
      payload: message.payload,
    })),
  } : {};
  await appendFile(env.webhookLogFile, `${JSON.stringify({
    at: new Date().toISOString(),
    status: "accepted",
    object: payload.object || null,
    entry_count: Array.isArray(payload.entry) ? payload.entry.length : 0,
    change_fields: changeFields,
    comment_count: comments.length,
    message_count: messages.length,
    ...content,
  })}\n`);
}

async function recordWebhookAttempt(status, body, req) {
  const signature = req.headers["x-hub-signature-256"] || req.headers["x-hub-signature"] || "";
  await mkdir(dirname(env.webhookLogFile), { recursive: true });
  await appendFile(env.webhookLogFile, `${JSON.stringify({
    at: new Date().toISOString(),
    status,
    bytes: body.length,
    signature_scheme: String(signature).split("=")[0] || null,
    signature_length: String(signature).length,
    user_agent: req.headers["user-agent"] || null,
  })}\n`);
}

async function readStateEvents() {
  let raw = "";
  try {
    raw = await readFile(env.stateFile, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

function summarizeRecentDeliveryErrors(events) {
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const errorStatuses = new Set(["dm_error", "public_reply_error", "message_error", "follow_gate_error"]);
  const errors = events.filter((event) => {
    if (!errorStatuses.has(event.status)) return false;
    if (String(event.message_id || "").startsWith("manual-replay-")) return false;
    const timestamp = new Date(event.at || 0).getTime();
    return Number.isFinite(timestamp) && timestamp >= sinceMs;
  });
  const threads = new Set(errors.map((event) => (
    event.comment_id || event.message_id || [event.from_id, event.media_id, event.keyword].filter(Boolean).join(":")
  )).filter(Boolean));
  const last = errors.at(-1) || null;
  return {
    delivery_error_count_24h: threads.size,
    delivery_error_event_count_24h: errors.length,
    delivery_last_error_at: last?.at || null,
    delivery_last_error_status: last?.status || null,
    delivery_last_error_keyword: last?.keyword || null,
  };
}

function readDeliveryStateFromEvents(events) {
  const state = new Map();
  for (const event of events) {
    if (!event.comment_id || !event.keyword) continue;
    const key = `${event.comment_id}:${event.keyword}`;
    const delivery = state.get(key) || { dmSent: false, publicSent: false };
    if (event.status === "dm_sent") delivery.dmSent = true;
    if (event.status === "public_reply_error" && event.dm_sent !== false) delivery.dmSent = true;
    if (event.status === "public_reply_sent") delivery.publicSent = true;
    if (event.status === "sent") {
      delivery.dmSent = true;
      delivery.publicSent = true;
    }
    state.set(key, delivery);
  }
  return state;
}

function readPendingFollowUpsFromEvents(events) {
  const pending = new Map();
  for (const event of events) {
    const key = pendingKey(event);
    if (!key) continue;
    if (event.follower_state === true || event.status === "follow_gate_guide_sent") {
      pending.delete(key);
      continue;
    }
    if (event.keyword && ["dm_sent", "sent", "message_sent"].includes(event.status)) {
      pending.set(key, { keyword: event.keyword });
    }
  }
  return pending;
}

function readPendingFollowUpsByUserFromEvents(events) {
  const pending = new Map();
  for (const event of events) {
    if (!event.from_id) continue;
    if (event.follower_state === true || event.status === "follow_gate_guide_sent") {
      pending.delete(String(event.from_id));
      continue;
    }
    if (event.keyword && ["dm_sent", "sent", "message_sent"].includes(event.status)) {
      pending.set(String(event.from_id), { keyword: event.keyword, mediaId: event.media_id || null });
    }
  }
  return pending;
}

function followGateKey(event) {
  if (!event.from_id || !event.media_id || !event.keyword) return null;
  return `${event.from_id}:${event.media_id}:${event.keyword}`;
}

function eventTimestamp(event) {
  const time = new Date(event.at || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function readPendingFollowGateFromEvents(events) {
  const pending = new Map();
  const pendingStatuses = new Set([
    "dm_sent",
    "sent",
    "message_sent",
    "follow_gate_reminder_sent",
    "dm_error",
    "public_reply_sent",
  ]);

  for (const event of events) {
    const key = followGateKey(event);
    if (event.follower_state === true || event.status === "follow_gate_guide_sent") {
      if (key) pending.delete(key);
      for (const [pendingKey, pendingEvent] of pending) {
        if (String(pendingEvent.from_id) === String(event.from_id) && eventTimestamp(pendingEvent) <= eventTimestamp(event)) {
          pending.delete(pendingKey);
        }
      }
      continue;
    }
    if (!key) continue;
    if (!pendingStatuses.has(event.status)) continue;
    const current = pending.get(key);
    if (current && eventTimestamp(current) > eventTimestamp(event)) continue;
    pending.set(key, {
      keyword: event.keyword,
      media_id: event.media_id,
      from_id: String(event.from_id),
      at: event.at || null,
    });
  }

  return pending;
}

function readKnownCommentRoutesFromEvents(events) {
  const known = new Map();
  for (const event of events) {
    if (!event.comment_id || !event.keyword) continue;
    known.set(String(event.comment_id), event.keyword);
  }
  return known;
}

function readHandledMessageIdsFromEvents(events) {
  const handled = new Set();
  for (const event of events) {
    if (event.message_id && String(event.status || "").startsWith("message_")) {
      handled.add(String(event.message_id));
    }
  }
  return handled;
}

function readDeliveredGuideKeysFromEvents(events) {
  const delivered = new Set();
  for (const event of events) {
    if (!event.from_id || !event.media_id || !event.keyword) continue;
    if (event.status === "follow_gate_guide_sent" || event.follower_state === true) {
      delivered.add(`${event.from_id}:${event.media_id}:${event.keyword}`);
    }
  }
  return delivered;
}

function readNonFollowerPromptCountsFromEvents(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.status !== "message_sent" || event.follower_state === true) continue;
    if (!event.from_id || !event.keyword) continue;
    const key = `${event.from_id}:${event.keyword}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function readDeliveryState() {
  return readDeliveryStateFromEvents(await readStateEvents());
}

async function handlePost(req, res) {
  const body = await readBody(req);
  if (!verifySignature(body, req.headers["x-hub-signature-256"])) {
    await recordWebhookAttempt("bad_signature", body, req);
    res.writeHead(403).end("bad signature");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    await recordWebhookAttempt("bad_json", body, req);
    res.writeHead(400).end("bad json");
    return;
  }

  const routes = await loadRoutes();
  const comments = extractComments(payload);
  const messages = extractMessages(payload);
  await recordWebhookReceipt(payload, comments, messages);
  const commentResults = await processComments(comments, routes);
  const messageResults = await processMessages(messages, routes);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, results: [...commentResults, ...messageResults], comments: commentResults, messages: messageResults }));
}

export async function processComments(comments, routes = null) {
  const activeRoutes = routes || await loadRoutes();
  const stateEvents = await readStateEvents();
  const deliveryState = readDeliveryStateFromEvents(stateEvents);
  const pendingFollowUps = readPendingFollowUpsFromEvents(stateEvents);
  const knownCommentRoutes = readKnownCommentRoutesFromEvents(stateEvents);
  const results = [];

  for (const comment of comments) {
    const commentRoutes = activeRoutes.filter((candidate) => routeMatchesComment(candidate, comment));
    const directRoute = matchRoute(comment.text, commentRoutes);
    const route = directRoute
      || findKnownCommentRoute(comment, commentRoutes, knownCommentRoutes)
      || findFollowUpRoute(comment, commentRoutes, pendingFollowUps);
    if (!route) {
      results.push({ commentId: comment.commentId, status: "ignored" });
      continue;
    }
    const handledKey = `${comment.commentId}:${route.keyword}`;
    const delivery = deliveryState.get(handledKey) || { dmSent: false, publicSent: false };
    if (delivery.dmSent && delivery.publicSent) {
      results.push({ commentId: comment.commentId, keyword: route.keyword, status: "skipped_duplicate" });
      continue;
    }
    const shouldAskFirst = directRoute === route;
    const resolvedComment = shouldAskFirst ? comment : await resolveFollowerState(route, comment);
    const attribution = deliveryAttribution(route, resolvedComment);
    const isGuideDelivery = !shouldAskFirst && (!route.requiresFollow || resolvedComment.followerState === true);
    const replyText = shouldAskFirst ? buildIntroReply(route) : buildReply(route, resolvedComment, attribution);
    const quickReplies = shouldAskFirst ? introQuickReplies(route, resolvedComment) : ctaQuickReplies(route, resolvedComment);
    updatePendingFollowUps(pendingFollowUps, resolvedComment, route);
    let dm = { skipped_duplicate: true };
    let dmError = null;
    if (!delivery.dmSent) {
      try {
        dm = await sendPrivateReply(resolvedComment, replyText, quickReplies);
        await recordEvent({
          status: "dm_sent",
          keyword: route.keyword,
          comment_id: resolvedComment.commentId,
          media_id: resolvedComment.mediaId,
          from_id: resolvedComment.fromId,
          follower_state: resolvedComment.followerState,
          ...attribution,
          funnel_event: shouldAskFirst
            ? "cta_conversation_started"
            : isGuideDelivery ? "cta_guide_delivered" : null,
          meta: dm,
        });
        delivery.dmSent = true;
        deliveryState.set(handledKey, delivery);
      } catch (error) {
        dmError = error;
        const retryKey = pendingKey(resolvedComment);
        if (retryKey) pendingFollowUps.set(retryKey, { keyword: route.keyword });
        await recordEvent({
          status: "dm_error",
          keyword: route.keyword,
          comment_id: resolvedComment.commentId,
          media_id: resolvedComment.mediaId,
          from_id: resolvedComment.fromId,
          follower_state: resolvedComment.followerState,
          ...attribution,
          funnel_event: "cta_delivery_failed",
          error: error.message,
        });
      }
    }

    let publicReply = { skipped_duplicate: true };
    if (!delivery.publicSent) {
      try {
        publicReply = await sendPublicCommentReply(resolvedComment, route.publicReplyText);
      } catch (error) {
        await recordEvent({
          status: "public_reply_error",
          keyword: route.keyword,
          comment_id: resolvedComment.commentId,
          media_id: resolvedComment.mediaId,
          dm_sent: delivery.dmSent,
          error: error.message,
        });
        results.push({
          commentId: resolvedComment.commentId,
          keyword: route.keyword,
          status: dmError ? "dm_error_public_reply_error" : "public_reply_error",
        });
        continue;
      }
      delivery.publicSent = true;
      deliveryState.set(handledKey, delivery);
      if (dmError) {
        await recordEvent({
          status: "public_reply_sent",
          keyword: route.keyword,
          comment_id: resolvedComment.commentId,
          media_id: resolvedComment.mediaId,
          from_id: resolvedComment.fromId,
          follower_state: resolvedComment.followerState,
          public_reply: publicReply,
        });
      }
    }

    if (dmError) {
      results.push({ commentId: resolvedComment.commentId, keyword: route.keyword, status: "dm_error_public_sent" });
      continue;
    }

    await recordEvent({
      status: "sent",
      keyword: route.keyword,
      comment_id: resolvedComment.commentId,
      media_id: resolvedComment.mediaId,
      from_id: resolvedComment.fromId,
      follower_state: resolvedComment.followerState,
      ...attribution,
      dm,
      public_reply: publicReply,
    });
    delivery.publicSent = true;
    deliveryState.set(handledKey, delivery);
    results.push({ commentId: resolvedComment.commentId, keyword: route.keyword, status: "sent" });
  }

  return results;
}

function routeFromMessage(message, routes, pendingFollowUpsByUser) {
  const parsed = parseQuickReplyPayload(message.payload);
  if (["CTA_WANTS_GUIDE", "CTA_FOLLOWED"].includes(parsed.action) && parsed.keyword) {
    const route = routes.find((candidate) => candidate.keyword === parsed.keyword);
    return route ? { route, mediaId: parsed.mediaId, askFirst: false, source: "quick_reply" } : null;
  }
  const followUp = findLatestFollowUpRoute(message, routes, pendingFollowUpsByUser);
  if (followUp) return { ...followUp, askFirst: false, source: "follow_up" };

  const route = matchDirectMessageRoute(message.text, routes);
  if (route) {
    const storyId = storyIdFromMessage(message);
    return {
      route,
      mediaId: storyId || `direct-dm:${route.keyword}`,
      askFirst: true,
      source: storyId ? "story_reply" : "direct_dm",
    };
  }

  const pending = pendingFollowUpsByUser.get(String(message.senderId));
  if (pending && String(message.text || "").trim()) {
    const pendingRoute = routes.find((candidate) => candidate.keyword === pending.keyword);
    if (pendingRoute) {
      return { route: pendingRoute, mediaId: pending.mediaId, askFirst: false, source: "pending_free_text" };
    }
  }
  return null;
}

function matchDirectMessageRoute(text, routes) {
  const tokens = keywordTokens(text);
  if (tokens.length !== 1) return null;
  return matchRoute(tokens[0], routes);
}

function storyIdFromMessage(message) {
  return message.storyId
    || message.raw?.message?.reply_to?.story?.id
    || message.raw?.reply_to?.story?.id
    || null;
}

function storyUrlFromMessage(message) {
  return message.storyUrl
    || message.raw?.message?.reply_to?.story?.url
    || message.raw?.reply_to?.story?.url
    || null;
}

async function processGenericMessage(message) {
  if (message.payload === "CTA_MORE_GUIDES") {
    return sendDirectMessage(message.igUserId, message.senderId, copy.moreGuidesMessage, [
      quickReply(copy.question, "CTA_QUESTION"),
      quickReply(copy.done, "CTA_DONE"),
    ]);
  }
  if (message.payload === "CTA_QUESTION") {
    return sendDirectMessage(message.igUserId, message.senderId, copy.questionMessage, [
      quickReply(copy.done, "CTA_DONE"),
    ]);
  }
  if (message.payload === "CTA_DONE") {
    return sendDirectMessage(message.igUserId, message.senderId, copy.doneMessage);
  }
  return null;
}

export async function processMessages(messages, routes = null) {
  const activeRoutes = routes || await loadRoutes();
  const stateEvents = await readStateEvents();
  const handledMessageIds = readHandledMessageIdsFromEvents(stateEvents);
  const pendingFollowUpsByUser = readPendingFollowUpsByUserFromEvents(stateEvents);
  const deliveredGuideKeys = readDeliveredGuideKeysFromEvents(stateEvents);
  const nonFollowerPromptCounts = readNonFollowerPromptCountsFromEvents(stateEvents);
  const handledRouteActions = new Set();
  const results = [];

  for (const message of messages) {
    if (handledMessageIds.has(message.messageId)) {
      results.push({ messageId: message.messageId, status: "skipped_duplicate" });
      continue;
    }

    const matched = routeFromMessage(message, activeRoutes, pendingFollowUpsByUser);
    if (!matched) {
      const generic = await processGenericMessage(message);
      if (generic) {
        await recordEvent({
          status: "message_sent",
          message_id: message.messageId,
          from_id: message.senderId,
          payload: message.payload,
          meta: generic,
        });
        results.push({ messageId: message.messageId, status: "sent" });
      } else {
        await recordEvent({
          status: "message_ignored",
          message_id: message.messageId,
          from_id: message.senderId,
          payload: message.payload,
          text: message.text,
        });
        results.push({ messageId: message.messageId, status: "ignored" });
      }
      continue;
    }

    const { route, mediaId, askFirst, source } = matched;
    const storyId = storyIdFromMessage(message);
    const storyUrl = storyUrlFromMessage(message);
    const routeActionKey = `${message.senderId}:${mediaId || ""}:${route.keyword}`;
    if (deliveredGuideKeys.has(routeActionKey)) {
      await recordEvent({
        status: "message_skipped_guide_delivered",
        keyword: route.keyword,
        message_id: message.messageId,
        media_id: mediaId,
        from_id: message.senderId,
        payload: message.payload,
      });
      results.push({ messageId: message.messageId, keyword: route.keyword, status: "skipped_guide_delivered" });
      continue;
    }
    if (handledRouteActions.has(routeActionKey)) {
      await recordEvent({
        status: "message_skipped_duplicate_action",
        keyword: route.keyword,
        message_id: message.messageId,
        media_id: mediaId,
        from_id: message.senderId,
        payload: message.payload,
      });
      results.push({ messageId: message.messageId, keyword: route.keyword, status: "skipped_duplicate_action" });
      continue;
    }
    handledRouteActions.add(routeActionKey);
    const comment = {
      igUserId: message.igUserId,
      commentId: message.messageId,
      mediaId,
      text: message.text,
      fromId: message.senderId,
      followerState: null,
      raw: message.raw,
    };
    const resolvedComment = askFirst ? comment : await resolveFollowerState(route, comment);
    const attribution = deliveryAttribution(route, resolvedComment);
    const isGuideDelivery = !askFirst && (!route.requiresFollow || resolvedComment.followerState === true);
    if (source === "pending_free_text" && resolvedComment.followerState !== true) {
      const promptKey = `${message.senderId}:${route.keyword}`;
      const promptCount = nonFollowerPromptCounts.get(promptKey) || 0;
      if (promptCount >= 2) {
        await recordEvent({
          status: "message_ignored",
          message_id: message.messageId,
          from_id: message.senderId,
          payload: message.payload,
          text: message.text,
          reason: "non_follower_prompt_capped",
          keyword: route.keyword,
        });
        results.push({ messageId: message.messageId, keyword: route.keyword, status: "ignored" });
        continue;
      }
      nonFollowerPromptCounts.set(promptKey, promptCount + 1);
    }
    const replyText = askFirst ? buildIntroReply(route) : buildReply(route, resolvedComment, attribution);
    const quickReplies = askFirst
      ? introQuickReplies(route, resolvedComment)
      : ctaQuickReplies(route, resolvedComment);
    try {
      const dm = await sendDirectMessage(message.igUserId, message.senderId, replyText, quickReplies);
      await recordEvent({
        status: "message_sent",
        keyword: route.keyword,
        message_id: message.messageId,
        media_id: mediaId,
        from_id: message.senderId,
        follower_state: resolvedComment.followerState,
        payload: message.payload,
        source,
        story_id: storyId,
        story_url: storyUrl,
        ...attribution,
        funnel_event: askFirst
          ? "cta_conversation_started"
          : isGuideDelivery ? "cta_guide_delivered" : null,
        meta: dm,
      });
      if (resolvedComment.followerState === true) {
        pendingFollowUpsByUser.delete(String(message.senderId));
        deliveredGuideKeys.add(routeActionKey);
      } else {
        pendingFollowUpsByUser.set(String(message.senderId), { keyword: route.keyword, mediaId });
      }
      results.push({ messageId: message.messageId, keyword: route.keyword, status: "sent" });
    } catch (error) {
      await recordEvent({
        status: "message_error",
        keyword: route.keyword,
        message_id: message.messageId,
        media_id: mediaId,
        from_id: message.senderId,
        follower_state: resolvedComment.followerState,
        payload: message.payload,
        ...attribution,
        funnel_event: "cta_delivery_failed",
        error: error.message,
      });
      results.push({ messageId: message.messageId, keyword: route.keyword, status: "error" });
    }
  }

  return results;
}

export async function processPendingFollowGate(routes = null) {
  const activeRoutes = routes || await loadRoutes();
  const stateEvents = await readStateEvents();
  const pending = readPendingFollowGateFromEvents(stateEvents);
  const results = [];
  const latestByUser = new Map();
  const minTs = Date.now() - env.followGateMaxAgeDays * 24 * 60 * 60 * 1000;

  for (const item of pending.values()) {
    if (eventTimestamp(item) < minTs) continue;
    const current = latestByUser.get(item.from_id);
    if (!current || eventTimestamp(item) > eventTimestamp(current)) {
      latestByUser.set(item.from_id, item);
    }
  }

  for (const item of latestByUser.values()) {
    const route = activeRoutes.find((candidate) => candidate.keyword === item.keyword);
    if (!route?.requiresFollow) continue;
    const comment = {
      igUserId: env.igUserId,
      commentId: `follow-gate:${item.from_id}:${item.media_id}:${item.keyword}`,
      mediaId: item.media_id,
      text: "",
      fromId: item.from_id,
      followerState: null,
      raw: item,
    };
    const resolvedComment = await resolveFollowerState(route, comment);
    if (resolvedComment.followerState !== true) {
      results.push({ fromId: item.from_id, keyword: route.keyword, status: "awaiting_follow" });
      continue;
    }
    const attribution = deliveryAttribution(route, resolvedComment);
    try {
      const dm = await sendDirectMessage(env.igUserId, item.from_id, buildReply(route, resolvedComment, attribution), ctaQuickReplies(route, resolvedComment));
      await recordEvent({
        status: "follow_gate_guide_sent",
        keyword: route.keyword,
        media_id: item.media_id,
        from_id: item.from_id,
        follower_state: true,
        ...attribution,
        funnel_event: "cta_guide_delivered",
        meta: dm,
      });
      results.push({ fromId: item.from_id, keyword: route.keyword, status: "follow_gate_guide_sent" });
    } catch (error) {
      await recordEvent({
        status: "follow_gate_error",
        keyword: route.keyword,
        media_id: item.media_id,
        from_id: item.from_id,
        follower_state: true,
        ...attribution,
        funnel_event: "cta_delivery_failed",
        error: error.message,
      });
      results.push({ fromId: item.from_id, keyword: route.keyword, status: "error" });
    }
  }

  return results;
}

function handleVerify(req, res, url) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.verifyToken && challenge) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(challenge);
    return;
  }

  res.writeHead(403).end("verification failed");
}

export function createServer() {
  assertConfig();
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && url.pathname === "/webhook") return handleVerify(req, res, url);
      if (req.method === "POST" && url.pathname === "/webhook") return handlePost(req, res);
      if (req.method === "GET" && url.pathname === "/health") {
        const deliveryErrors = summarizeRecentDeliveryErrors(await readStateEvents());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          dry_run: env.dryRun,
          poll_enabled: env.pollEnabled,
          poll_interval_ms: env.pollIntervalMs,
          poll_since_iso: pollStatus.sinceIso,
          poll_last_run_at: pollStatus.lastRunAt,
          poll_last_error: pollStatus.lastError,
          poll_last_media_count: pollStatus.mediaCount,
          poll_last_comment_count: pollStatus.commentCount,
          poll_last_message_count: pollStatus.messageCount,
          poll_last_result_count: pollStatus.resultCount,
          ...deliveryErrors,
          follow_gate_enabled: env.followGateEnabled,
          follow_gate_mode: "guide_only",
          follow_gate_last_result_count: pollStatus.followGateResultCount,
        }));
        return;
      }
      res.writeHead(404).end("not found");
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
}

async function graphGet(path, params = {}) {
  const url = new URL(`${env.graphBaseUrl}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("access_token", env.accessToken);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta poll failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function graphGetPages(path, params, maxPages, stopAfterPage = null) {
  const rows = [];
  let after = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const data = await graphGet(path, { ...params, after });
    const page = Array.isArray(data.data) ? data.data : [];
    rows.push(...page);
    if (stopAfterPage?.(page)) break;
    if (!data.paging?.next) break;
    after = data.paging?.cursors?.after || null;
    if (!after) break;
  }
  return rows;
}

async function fetchRecentMedia() {
  const data = await graphGet(`${env.igUserId}/media`, {
    fields: "id,permalink,timestamp",
    limit: env.pollMediaLimit,
  });
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchMediaComments(mediaId, sinceIso) {
  return graphGetPages(`${mediaId}/comments`, {
    fields: "id,text,timestamp,username,from",
    limit: env.pollCommentsLimit,
  }, env.pollMaxCommentPages, (page) => (
    page.length > 0 && page.every((comment) => !isNewEnough(comment, sinceIso))
  ));
}

async function readPollSinceIso() {
  if (process.env.POLL_SINCE_ISO) return env.initialPollSinceIso;
  try {
    const raw = await readFile(env.pollCursorFile, "utf8");
    const cursor = JSON.parse(raw);
    return cursor.since_iso || env.initialPollSinceIso;
  } catch {
    return env.initialPollSinceIso;
  }
}

async function readMessagePollSinceIso() {
  if (process.env.POLL_SINCE_ISO) return env.initialPollSinceIso;
  try {
    const raw = await readFile(env.messagePollCursorFile, "utf8");
    const cursor = JSON.parse(raw);
    return cursor.since_iso || env.initialPollSinceIso;
  } catch {
    return env.initialPollSinceIso;
  }
}

async function writePollCursor(sinceIso) {
  if (process.env.POLL_SINCE_ISO) return;
  await mkdir(dirname(env.pollCursorFile), { recursive: true });
  await writeFile(env.pollCursorFile, `${JSON.stringify({ since_iso: sinceIso, updated_at: new Date().toISOString() })}\n`);
}

async function writeMessagePollCursor(sinceIso) {
  if (process.env.POLL_SINCE_ISO) return;
  await mkdir(dirname(env.messagePollCursorFile), { recursive: true });
  await writeFile(env.messagePollCursorFile, `${JSON.stringify({ since_iso: sinceIso, updated_at: new Date().toISOString() })}\n`);
}

function isNewEnough(comment, sinceIso) {
  if (!comment.timestamp) return true;
  return new Date(comment.timestamp).getTime() >= new Date(sinceIso).getTime();
}

function isMessageNewEnough(message, sinceIso) {
  if (!message.created_time) return true;
  return new Date(message.created_time).getTime() >= new Date(sinceIso).getTime();
}

function commentTime(comment) {
  const timestamp = comment.raw?.timestamp || comment.timestamp;
  if (!timestamp) return 0;
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function messageTime(message) {
  const time = new Date(message.created_time || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function commentFromPolledMedia(media, comment) {
  return {
    igUserId: env.igUserId,
    commentId: String(comment.id),
    mediaId: String(media.id),
    text: String(comment.text || ""),
    fromId: comment.from?.id || null,
    followerState: inferFollowerState(comment),
    timestamp: comment.timestamp || null,
    raw: comment,
  };
}

async function fetchConversationMessages(conversationId, sinceIso) {
  return graphGetPages(`${conversationId}/messages`, {
    fields: "id,message,from,to,created_time,reply_to",
    limit: env.pollMessagesLimit,
  }, env.pollMaxMessagePages, (page) => (
    page.length > 0 && page.every((message) => !isMessageNewEnough(message, sinceIso))
  ));
}

async function fetchRecentConversations(sinceIso) {
  const conversations = await graphGetPages(`${env.igUserId}/conversations`, {
    platform: "instagram",
    fields: "id,updated_time",
    limit: env.pollConversationLimit,
  }, env.pollMaxConversationPages, (page) => (
    page.length > 0 && page.every((conversation) => (
      conversation.updated_time && !isMessageNewEnough({ created_time: conversation.updated_time }, sinceIso)
    ))
  ));

  return Promise.all(conversations
    .filter((conversation) => (
      !conversation.updated_time || isMessageNewEnough({ created_time: conversation.updated_time }, sinceIso)
    ))
    .map(async (conversation) => ({
      ...conversation,
      messages: conversation.messages || {
        data: await fetchConversationMessages(conversation.id, sinceIso),
      },
    })));
}

function messagesFromPolledConversations(conversations, sinceIso) {
  const seen = new Set();
  const messages = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages?.data || []) {
      const senderId = message.from?.id ? String(message.from.id) : "";
      if (!senderId || senderId === String(env.igUserId)) continue;
      if (!message.id || !isMessageNewEnough(message, sinceIso)) continue;
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push({
        igUserId: env.igUserId,
        senderId,
        messageId: String(message.id),
        text: String(message.message || ""),
        payload: "",
        storyId: message.reply_to?.story?.id ? String(message.reply_to.story.id) : null,
        storyUrl: message.reply_to?.story?.url ? String(message.reply_to.story.url) : null,
        raw: message,
      });
    }
  }
  messages.sort((a, b) => messageTime(a.raw) - messageTime(b.raw));
  return messages;
}

export async function pollOnce() {
  const scanStartedAt = new Date().toISOString();
  const sinceIso = await readPollSinceIso();
  const messageSinceIso = await readMessagePollSinceIso();
  const mediaItems = await fetchRecentMedia();
  const comments = [];
  for (const media of mediaItems) {
    const mediaComments = await fetchMediaComments(media.id, sinceIso);
    for (const comment of mediaComments) {
      if (!comment.id || !comment.text || !isNewEnough(comment, sinceIso)) continue;
      comments.push(commentFromPolledMedia(media, comment));
    }
  }
  comments.sort((a, b) => commentTime(a) - commentTime(b));
  const conversations = await fetchRecentConversations(messageSinceIso);
  const messages = messagesFromPolledConversations(conversations, messageSinceIso);
  const commentResults = await processComments(comments);
  const messageResults = await processMessages(messages);
  await writePollCursor(scanStartedAt);
  await writeMessagePollCursor(scanStartedAt);
  pollStatus.lastRunAt = new Date().toISOString();
  pollStatus.lastError = null;
  pollStatus.sinceIso = scanStartedAt;
  pollStatus.mediaCount = mediaItems.length;
  pollStatus.commentCount = comments.length;
  pollStatus.messageCount = messages.length;
  pollStatus.resultCount = commentResults.length + messageResults.length;
  return [...commentResults, ...messageResults];
}

function startPollLoop() {
  console.log(`instagram polling enabled every ${env.pollIntervalMs}ms since ${env.initialPollSinceIso}`);
  let running = false;
  let lastFollowGateRunAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const results = await pollOnce();
      console.log(`instagram poll scanned ${pollStatus.mediaCount} media, ${pollStatus.commentCount} comments, ${results.length} results`);
      if (env.followGateEnabled && Date.now() - lastFollowGateRunAt >= env.followGateIntervalMs) {
        lastFollowGateRunAt = Date.now();
        const followGateResults = await processPendingFollowGate();
        pollStatus.followGateResultCount = followGateResults.length;
        console.log(`instagram follow gate guide-only checked ${followGateResults.length} pending users`);
      }
    } catch (error) {
      pollStatus.lastRunAt = new Date().toISOString();
      pollStatus.lastError = error.message;
      console.error(`instagram poll error: ${error.message}`);
    } finally {
      running = false;
    }
  };
  setInterval(run, env.pollIntervalMs);
  run();
}

export function startServer() {
  assertConfig();
  const server = createServer();
  server.listen(env.port, env.host, () => {
    console.log(`instagram-cta listening on http://${env.host}:${env.port}`);
    if (env.pollEnabled) startPollLoop();
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
