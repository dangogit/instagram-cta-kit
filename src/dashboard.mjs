import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

// Served at /dashboard by src/server.mjs. Zero dependencies, one HTML page,
// two JSON endpoints. Auth reuses CTA_ADMIN_TOKEN because the whole server is
// often exposed through a tunnel for webhooks - the dashboard must never be
// reachable without the token.

const MEDIA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SUMMARY_CACHE_TTL_MS = 15 * 1000;
const MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username";
const COOKIE_NAME = "cta_dashboard";

// A guide delivery is the completed "sent" event of the comment flow (dm_sent is
// the DM leg of the same delivery and would double-count), a follow-gate guide
// send, or a message-flow send whose funnel event marks an actual guide handoff
// (message_sent without it is an intro or intent reply).
export function isGuideDelivery(event) {
  if (!event || !event.keyword) return false;
  if (event.status === "sent") return true;
  if (event.status === "follow_gate_guide_sent") return true;
  if (event.status === "message_sent") return event.funnel_event === "cta_guide_delivered";
  return false;
}

function isErrorEvent(event) {
  return typeof event?.status === "string" && event.status.endsWith("_error");
}

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function buildSummaryFromEvents(events, routes, { now = new Date(), days = 14 } = {}) {
  const nowMs = now.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayKey = localDateKey(now);
  const weekAgoMs = nowMs - 7 * dayMs;
  const dayAgoMs = nowMs - dayMs;

  const dailyKeys = [];
  const daily = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = localDateKey(new Date(nowMs - i * dayMs));
    dailyKeys.push(key);
    daily.set(key, 0);
  }

  const perRoute = new Map();
  const routeFor = (keyword) => {
    if (!perRoute.has(keyword)) {
      perRoute.set(keyword, {
        delivered_total: 0,
        delivered_7d: 0,
        last_delivered_at: null,
        media: new Map(),
      });
    }
    return perRoute.get(keyword);
  };

  let deliveredTotal = 0;
  let delivered7d = 0;
  let deliveredToday = 0;
  let errors24h = 0;
  const recent = [];

  for (const event of events) {
    const atMs = Date.parse(event?.at || "");
    if (isErrorEvent(event) && Number.isFinite(atMs) && atMs >= dayAgoMs) errors24h += 1;
    if (isGuideDelivery(event)) {
      deliveredTotal += 1;
      const stats = routeFor(event.keyword);
      stats.delivered_total += 1;
      if (Number.isFinite(atMs)) {
        if (atMs >= weekAgoMs) {
          delivered7d += 1;
          stats.delivered_7d += 1;
        }
        const key = localDateKey(atMs);
        if (key === todayKey) deliveredToday += 1;
        if (daily.has(key)) daily.set(key, daily.get(key) + 1);
        if (!stats.last_delivered_at || atMs > Date.parse(stats.last_delivered_at)) {
          stats.last_delivered_at = event.at;
        }
      }
      // Synthetic ids like "direct-dm:WATCH" mark story or DM deliveries with no
      // real post behind them - only numeric ids are fetchable Instagram media.
      const mediaId = event.media_id ? String(event.media_id) : null;
      if (mediaId && /^\d+$/.test(mediaId)) {
        stats.media.set(mediaId, (stats.media.get(mediaId) || 0) + 1);
      }
    }
    if (isRecentWorthy(event)) recent.push(event);
  }

  const routesOut = routes.map((route) => {
    const stats = perRoute.get(route.keyword) || {
      delivered_total: 0, delivered_7d: 0, last_delivered_at: null, media: new Map(),
    };
    const media = [...stats.media.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([media_id, delivered]) => ({ media_id, delivered }));
    for (const configured of route.mediaIds || []) {
      const id = String(configured);
      if (/^\d+$/.test(id) && !media.some((m) => m.media_id === id)) {
        media.push({ media_id: id, delivered: 0 });
      }
    }
    return {
      keyword: route.keyword,
      aliases: route.aliases || [],
      campaign_id: route.campaignId,
      guide_url: route.guideUrl || "",
      requires_follow: route.requiresFollow === true,
      delivered_total: stats.delivered_total,
      delivered_7d: stats.delivered_7d,
      last_delivered_at: stats.last_delivered_at,
      media,
    };
  }).sort((a, b) => b.delivered_total - a.delivered_total);

  return {
    generated_at: now.toISOString(),
    totals: {
      delivered_total: deliveredTotal,
      delivered_7d: delivered7d,
      delivered_today: deliveredToday,
      errors_24h: errors24h,
      active_routes: routes.length,
    },
    daily: dailyKeys.map((date) => ({ date, delivered: daily.get(date) })),
    routes: routesOut,
    recent: recent.slice(-40).reverse().map((event) => ({
      at: event.at || null,
      status: event.status,
      keyword: event.keyword || null,
      funnel_event: event.funnel_event || null,
    })),
  };
}

function isRecentWorthy(event) {
  const status = String(event?.status || "");
  if (isGuideDelivery(event)) return true;
  if (isErrorEvent(event)) return true;
  if (status === "message_sent" && event.keyword) return true;
  if (status === "follow_gate_reminder_sent") return true;
  if (status === "human_takeover_detected") return true;
  return false;
}

function tokenMatches(supplied, expected) {
  if (!supplied || !expected) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function createDashboard({ env, readStateEvents, loadRoutes, graphGet, packageVersion, locale = "en" }) {
  const mediaCacheFile = resolve(dirname(env.stateFile), "media-cache.json");
  let summaryCache = null;
  let mediaCache = null;

  function authorized(req, url) {
    if (!env.adminToken) return env.dryRun;
    const bearer = String(req.headers.authorization || "");
    if (bearer.startsWith("Bearer ") && tokenMatches(bearer.slice(7), env.adminToken)) return true;
    if (tokenMatches(url.searchParams.get("token"), env.adminToken)) return true;
    return tokenMatches(readCookie(req, COOKIE_NAME), env.adminToken);
  }

  async function summary() {
    if (summaryCache && Date.now() - summaryCache.at < SUMMARY_CACHE_TTL_MS) return summaryCache.data;
    const [events, routes] = await Promise.all([readStateEvents(), loadRoutes()]);
    const data = buildSummaryFromEvents(events, routes);
    data.service = {
      provider: env.provider,
      dry_run: env.dryRun,
      follow_gate_enabled: env.followGateEnabled,
      poll_enabled: env.pollEnabled,
      version: packageVersion,
      locale,
    };
    summaryCache = { at: Date.now(), data };
    return data;
  }

  async function loadMediaCache() {
    if (mediaCache) return mediaCache;
    try {
      mediaCache = JSON.parse(await readFile(mediaCacheFile, "utf8"));
    } catch {
      mediaCache = {};
    }
    return mediaCache;
  }

  async function mediaMeta(mediaId) {
    const cache = await loadMediaCache();
    const hit = cache[mediaId];
    if (hit && Date.now() - Date.parse(hit.fetched_at) < MEDIA_CACHE_TTL_MS) return hit.data;
    const raw = await graphGet(mediaId, { fields: MEDIA_FIELDS });
    const data = {
      id: String(raw.id || mediaId),
      media_type: raw.media_type || null,
      media_url: raw.media_url || null,
      thumbnail_url: raw.thumbnail_url || null,
      permalink: raw.permalink || null,
      caption: raw.caption || "",
      timestamp: raw.timestamp || null,
      like_count: Number.isFinite(raw.like_count) ? raw.like_count : null,
      comments_count: Number.isFinite(raw.comments_count) ? raw.comments_count : null,
      username: raw.username || null,
    };
    cache[mediaId] = { fetched_at: new Date().toISOString(), data };
    try {
      await mkdir(dirname(mediaCacheFile), { recursive: true });
      await writeFile(mediaCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch {
      // cache write failure must never break the response
    }
    return data;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function sendHtml(res, status, html, extraHeaders = {}) {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...extraHeaders,
    });
    res.end(html);
  }

  async function handle(req, res, url) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    const path = url.pathname.replace(/\/+$/, "") || "/dashboard";

    if (path === "/dashboard") {
      if (!authorized(req, url)) {
        sendHtml(res, 401, unauthorizedPage(locale));
        return;
      }
      // Landing with ?token= sets the cookie and cleans the URL so the token
      // does not linger in the address bar or browser history beyond this hop.
      if (url.searchParams.get("token")) {
        res.writeHead(302, {
          "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(env.adminToken)}; HttpOnly; SameSite=Strict; Path=/dashboard`,
          "Location": "/dashboard",
        });
        res.end();
        return;
      }
      sendHtml(res, 200, dashboardPage(locale));
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (path === "/dashboard/api/summary") {
      sendJson(res, 200, { ok: true, ...(await summary()) });
      return;
    }

    const mediaMatch = path.match(/^\/dashboard\/api\/media\/(\d+)$/);
    if (mediaMatch) {
      try {
        sendJson(res, 200, { ok: true, media: await mediaMeta(mediaMatch[1]) });
      } catch (error) {
        console.error(`dashboard media fetch failed for ${mediaMatch[1]}: ${error?.message}`);
        sendJson(res, 502, { ok: false, error: "media_fetch_failed" });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  }

  return { handle, summary, mediaMeta };
}

const COPY = {
  he: {
    dir: "rtl",
    lang: "he",
    title: "דשבורד CTA",
    subtitle: "האוטומציה של האינסטגרם שלך, בזמן אמת",
    statusOk: "פעיל ותקין",
    statusIssues: "יש בעיה, בדוק את השירות",
    dryRun: "מצב תרגול",
    followGate: "חובת מעקב פעילה",
    provider: { hookmyapp: "HookMyApp", meta: "Meta API" },
    kpiTotal: "מדריכים נשלחו",
    kpiWeek: "בשבוע האחרון",
    kpiToday: "היום",
    kpiErrors: "שגיאות ב-24 שעות",
    chartTitle: "מדריכים שנשלחו, 14 הימים האחרונים",
    chartTable: "הצג כטבלה",
    thDate: "תאריך",
    thCount: "נשלחו",
    routesTitle: "האוטומציות הפעילות",
    routesHint: "לחיצה על שורה מראה את הפוסט שהאוטומציה מחוברת אליו",
    requiresFollow: "עוקבים בלבד",
    delivered: "נשלחו",
    lastSent: "אחרון",
    never: "עדיין לא נשלח",
    activityTitle: "פעילות אחרונה",
    emptyRoutes: "אין עדיין אוטומציות. מוסיפים מילת מפתח עם: npx instagram-cta route add",
    emptyActivity: "עוד אין פעילות. ברגע שמישהו יגיב עם מילת מפתח, זה יופיע כאן",
    emptyChart: "עוד אין נתונים להצגה",
    modalDeliveries: (n) => `${n} מדריכים נשלחו מהפוסט הזה`,
    modalOpen: "פתיחה באינסטגרם",
    modalNoMedia: "עוד אין פוסט מקושר לאוטומציה הזאת. ברגע שמישהו יגיב עם מילת המפתח, הפוסט יופיע כאן",
    modalMediaError: "לא הצלחתי למשוך את הפוסט מאינסטגרם. אפשר לנסות שוב עוד רגע",
    modalGuide: "המדריך שנשלח",
    likes: "לייקים",
    comments: "תגובות",
    updated: "עודכן",
    justNow: "ממש עכשיו",
    minutesAgo: (n) => `לפני ${n} דק׳`,
    hoursAgo: (n) => `לפני ${n} שע׳`,
    daysAgo: (n) => (n === 1 ? "אתמול" : `לפני ${n} ימים`),
    footer: "הדשבורד רץ אצלך על המחשב. הנתונים לא נשלחים לשום מקום",
    statusLabels: {
      sent: "מדריך נשלח בתגובה",
      message_sent_guide: "מדריך נשלח בהודעה",
      message_sent: "שיחה נפתחה",
      follow_gate_guide_sent: "מדריך נשלח אחרי מעקב",
      follow_gate_reminder_sent: "תזכורת מעקב נשלחה",
      human_takeover_detected: "זוהה מענה אנושי, הבוט השתתק",
      error: "שגיאת שליחה",
    },
  },
  en: {
    dir: "ltr",
    lang: "en",
    title: "CTA Dashboard",
    subtitle: "Your Instagram automation, live",
    statusOk: "Running and healthy",
    statusIssues: "Something needs attention",
    dryRun: "Dry run",
    followGate: "Follow gate on",
    provider: { hookmyapp: "HookMyApp", meta: "Meta API" },
    kpiTotal: "Guides delivered",
    kpiWeek: "Last 7 days",
    kpiToday: "Today",
    kpiErrors: "Errors in 24h",
    chartTitle: "Guides delivered, last 14 days",
    chartTable: "Show as table",
    thDate: "Date",
    thCount: "Delivered",
    routesTitle: "Active automations",
    routesHint: "Click a row to see the post this automation is attached to",
    requiresFollow: "Followers only",
    delivered: "delivered",
    lastSent: "last",
    never: "Nothing sent yet",
    activityTitle: "Recent activity",
    emptyRoutes: "No automations yet. Add a keyword with: npx instagram-cta route add",
    emptyActivity: "No activity yet. As soon as someone comments a keyword it will show up here",
    emptyChart: "No data yet",
    modalDeliveries: (n) => `${n} guides delivered from this post`,
    modalOpen: "Open on Instagram",
    modalNoMedia: "No post linked to this automation yet. Once someone comments the keyword, the post will appear here",
    modalMediaError: "Could not fetch the post from Instagram. Try again in a moment",
    modalGuide: "Guide being sent",
    likes: "likes",
    comments: "comments",
    updated: "Updated",
    justNow: "just now",
    minutesAgo: (n) => `${n}m ago`,
    hoursAgo: (n) => `${n}h ago`,
    daysAgo: (n) => (n === 1 ? "yesterday" : `${n}d ago`),
    footer: "This dashboard runs on your machine. Nothing is sent anywhere",
    statusLabels: {
      sent: "Guide sent via comment",
      message_sent_guide: "Guide sent via DM",
      message_sent: "Conversation started",
      follow_gate_guide_sent: "Guide sent after follow",
      follow_gate_reminder_sent: "Follow reminder sent",
      human_takeover_detected: "Human reply detected, bot muted",
      error: "Delivery error",
    },
  },
};

function unauthorizedPage(locale) {
  const he = locale === "he";
  return `<!doctype html><html lang="${he ? "he" : "en"}" dir="${he ? "rtl" : "ltr"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${he ? "דשבורד CTA" : "CTA Dashboard"}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141413;color:#faf9f5;font-family:-apple-system,"Segoe UI","Assistant","Heebo",sans-serif}
.card{max-width:420px;padding:40px;border:1px solid #2a2927;border-radius:20px;background:#1c1b19;text-align:center}
h1{font-size:20px;margin:0 0 12px}p{color:#a8a49c;line-height:1.7;margin:0 0 8px}
code{direction:ltr;display:inline-block;background:#141413;border:1px solid #2a2927;border-radius:8px;padding:8px 14px;margin-top:12px;color:#d97757}</style>
</head><body><div class="card"><h1>${he ? "צריך קישור עם טוקן" : "A tokenized link is required"}</h1>
<p>${he ? "הדשבורד מוגן. כדי לקבל את הקישור, מריצים בתיקיית ההתקנה:" : "The dashboard is protected. To get your link, run in the install folder:"}</p>
<code>npx instagram-cta dashboard</code></div></body></html>`;
}

function dashboardPage(locale) {
  const c = COPY[locale] || COPY.en;
  const copyJson = JSON.stringify({
    ...c,
    modalDeliveries: undefined, minutesAgo: undefined, hoursAgo: undefined, daysAgo: undefined,
  });
  return `<!doctype html>
<html lang="${c.lang}" dir="${c.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${c.title}</title>
<style>
:root{
  --bg:#141413; --card:#1c1b19; --card2:#232220; --border:#2a2927; --border2:#3a3835;
  --ink:#faf9f5; --muted:#a8a49c; --faint:#6e6a63;
  --accent:#d97757; --good:#788c5d; --bad:#c25e5e; --blue:#6a9bcc;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,"Segoe UI","Assistant","Heebo",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--blue);text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 60px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:26px}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#b35c3f);display:grid;place-items:center;font-weight:800;font-size:17px;color:#fff;box-shadow:0 4px 18px rgba(217,119,87,.35)}
.brand h1{font-size:19px;margin:0;letter-spacing:-.2px}
.brand .sub{font-size:12.5px;color:var(--muted);margin-top:2px}
.badges{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.badge{font-size:12px;padding:5px 11px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--muted);display:inline-flex;align-items:center;gap:6px}
.badge .dot{width:7px;height:7px;border-radius:50%}
.badge.ok{border-color:rgba(120,140,93,.5);color:#a8bd8b}
.badge.ok .dot{background:var(--good);box-shadow:0 0 0 0 rgba(120,140,93,.6);animation:pulse 2.4s infinite}
.badge.warn{border-color:rgba(194,94,94,.5);color:#d99090}
.badge.warn .dot{background:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(120,140,93,.45)}70%{box-shadow:0 0 0 7px rgba(120,140,93,0)}100%{box-shadow:0 0 0 0 rgba(120,140,93,0)}}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:20px 22px;position:relative;overflow:hidden}
.kpi .label{font-size:12.5px;color:var(--muted);margin-bottom:10px}
.kpi .value{font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums}
.kpi.hero{background:linear-gradient(145deg,#241d19,#1c1b19);border-color:rgba(217,119,87,.35)}
.kpi.hero .value{color:var(--accent);font-size:40px}
.kpi .spark{position:absolute;inset-inline-end:16px;top:18px;opacity:.9}
.grid{display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:22px}
.card h2{font-size:14.5px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
.card .hint{font-size:12px;color:var(--faint);margin-bottom:16px}
.chart-box{direction:ltr;margin-top:6px}
.chart-box svg{display:block;width:100%;height:190px}
.bar{fill:var(--accent);rx:4}
.bar:hover{fill:#e89275}
.gridline{stroke:var(--border);stroke-width:1}
.axis-label{fill:var(--faint);font-size:10.5px;font-family:inherit}
.bar-label{fill:var(--ink);font-size:11px;font-weight:700;font-family:inherit}
.tooltip{position:fixed;z-index:50;background:var(--card2);border:1px solid var(--border2);border-radius:10px;padding:8px 12px;font-size:12.5px;pointer-events:none;display:none;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.tooltip b{font-variant-numeric:tabular-nums}
details.tbl{margin-top:10px;direction:${c.dir}}
details.tbl summary{font-size:12px;color:var(--faint);cursor:pointer}
details.tbl table{width:100%;margin-top:8px;border-collapse:collapse;font-size:12.5px}
details.tbl td,details.tbl th{padding:5px 8px;border-bottom:1px solid var(--border);text-align:start;color:var(--muted)}
.routes{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.route{display:flex;align-items:center;gap:14px;padding:13px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card2);cursor:pointer;transition:border-color .15s,transform .15s;text-align:start;width:100%;color:inherit;font:inherit}
.route:hover{border-color:rgba(217,119,87,.55);transform:translateY(-1px)}
.kw{font-weight:800;font-size:13.5px;background:rgba(217,119,87,.14);color:var(--accent);border:1px solid rgba(217,119,87,.35);padding:5px 12px;border-radius:9px;letter-spacing:.4px;white-space:nowrap;direction:ltr}
.route .mid{flex:1;min-width:0}
.route .guide{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:ltr;text-align:${c.dir === "rtl" ? "right" : "left"}}
.route .meta{display:flex;gap:8px;margin-top:5px;flex-wrap:wrap}
.chip{font-size:10.5px;padding:2.5px 8px;border-radius:999px;border:1px solid var(--border);color:var(--faint)}
.chip.follow{border-color:rgba(106,155,204,.4);color:var(--blue)}
.route .num{font-size:21px;font-weight:800;font-variant-numeric:tabular-nums;min-width:44px;text-align:center}
.route .when{font-size:11px;color:var(--faint);white-space:nowrap}
.route .arrow{color:var(--faint);font-size:16px}
.feed{display:flex;flex-direction:column;gap:2px}
.evt{display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid rgba(42,41,39,.6);font-size:12.5px}
.evt:last-child{border-bottom:none}
.evt .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.evt .dot.good{background:var(--good)}.evt .dot.bad{background:var(--bad)}.evt .dot.info{background:var(--blue)}.evt .dot.mute{background:var(--faint)}
.evt .what{flex:1;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pager{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:14px}
.pager button{background:var(--card2);border:1px solid var(--border);color:var(--muted);width:30px;height:30px;border-radius:9px;cursor:pointer;font-size:15px;line-height:1}
.pager button:hover:not(:disabled){border-color:var(--border2);color:var(--ink)}
.pager button:disabled{opacity:.3;cursor:default}
.pager .pg{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;direction:ltr}
.evt .kw-mini{color:var(--accent);font-weight:700;direction:ltr;display:inline-block}
.evt time{color:var(--faint);font-size:11px;white-space:nowrap}
.empty{color:var(--faint);font-size:13px;padding:18px 4px;text-align:center;line-height:1.7}
footer{margin-top:26px;text-align:center;font-size:11.5px;color:var(--faint)}
.updated{font-size:11px;color:var(--faint)}
/* phone modal */
.overlay{position:fixed;inset:0;background:rgba(10,10,9,.7);backdrop-filter:blur(6px);display:none;z-index:100;padding:24px;overflow-y:auto}
.overlay.open{display:flex}
.sheet{display:flex;gap:26px;align-items:center;max-width:820px;flex-wrap:wrap;justify-content:center;margin:auto}
.phone{width:290px;background:#000;border-radius:40px;padding:11px;border:1px solid #3a3835;box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 0 0 2px #1a1a1a;animation:rise .25s ease}
@keyframes rise{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
.screen{background:#000;border-radius:34px;overflow:hidden;position:relative;direction:ltr}
.notch{height:26px;display:grid;place-items:center}
.notch i{width:86px;height:20px;background:#111;border-radius:12px;display:block}
.ig-head{display:flex;align-items:center;gap:9px;padding:9px 12px}
.avatar{width:34px;height:34px;border-radius:50%;padding:2px;background:conic-gradient(#f9ce34,#ee2a7b,#6228d7,#f9ce34)}
.avatar i{display:block;width:100%;height:100%;border-radius:50%;background:linear-gradient(135deg,var(--accent),#8a4630);border:2px solid #000}
.ig-user{font-size:12.5px;font-weight:700;color:#fff;flex:1}
.ig-dots{color:#fff;letter-spacing:2px;font-weight:700}
.ig-media{width:100%;aspect-ratio:4/5;background:#191817;display:grid;place-items:center;position:relative}
.ig-media img{width:100%;height:100%;object-fit:cover;display:block}
.screen.embed .ig-head,.screen.embed .ig-actions,.screen.embed .ig-likes,.screen.embed .ig-cap{display:none}
.screen.embed .ig-media{aspect-ratio:auto;height:585px;background:#fff}
.screen iframe{width:100%;height:100%;border:0;display:block;background:#fff}
.ig-media .ph{color:var(--faint);font-size:12px;padding:20px;text-align:center;direction:${c.dir}}
.ig-actions{display:flex;gap:14px;padding:10px 12px 4px;color:#fff}
.ig-actions svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ig-actions .save{margin-inline-start:auto}
.ig-likes{padding:0 12px;font-size:12px;font-weight:700;color:#fff}
.ig-cap{padding:4px 12px 14px;font-size:11.5px;color:#e8e6e1;line-height:1.5;max-height:120px;overflow-y:auto;unicode-bidi:plaintext}
.ig-cap b{color:#fff}
.ig-cap mark{background:rgba(217,119,87,.35);color:#ffd3c2;border-radius:3px;padding:0 3px;font-weight:700}
.side{max-width:300px;display:flex;flex-direction:column;gap:14px;direction:${c.dir}}
.side .kw{align-self:flex-start;font-size:16px;padding:8px 16px}
.side .stat{font-size:14px;color:var(--muted);line-height:1.7}
.side .stat b{color:var(--ink);font-size:20px}
.side .guide-link{font-size:12.5px;direction:ltr;overflow-wrap:anywhere;color:var(--blue)}
.side .btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;font-weight:700;font-size:13.5px;padding:11px 20px;border-radius:12px;transition:opacity .15s}
.side .btn:hover{opacity:.88}
.side .lbl{font-size:11px;color:var(--faint)}
.thumbs{display:flex;gap:8px;flex-wrap:wrap}
.thumbs button{width:46px;height:46px;border-radius:10px;border:2px solid var(--border);background:var(--card2);cursor:pointer;overflow:hidden;padding:0}
.thumbs button.on{border-color:var(--accent)}
.thumbs img{width:100%;height:100%;object-fit:cover;display:block}
.close-x{position:absolute;top:18px;inset-inline-end:22px;background:var(--card);border:1px solid var(--border2);color:var(--muted);width:38px;height:38px;border-radius:50%;font-size:16px;cursor:pointer}
.spin{width:26px;height:26px;border:3px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <div class="logo">▶</div>
      <div><h1>${c.title}</h1><div class="sub">${c.subtitle}</div></div>
    </div>
    <div class="badges" id="badges"></div>
  </header>

  <section class="kpis" id="kpis"></section>

  <div class="grid">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="card">
        <h2>${c.chartTitle}</h2>
        <div class="chart-box" id="chart"></div>
        <details class="tbl"><summary>${c.chartTable}</summary><div id="chart-table"></div></details>
      </div>
      <div class="card">
        <h2>${c.routesTitle}</h2>
        <div class="hint">${c.routesHint}</div>
        <div class="routes" id="routes"></div>
      </div>
    </div>
    <div class="card">
      <h2>${c.activityTitle}</h2>
      <div class="feed" id="feed"></div>
    </div>
  </div>

  <footer>${c.footer} · <span class="updated" id="updated"></span> · <span id="version"></span></footer>
</div>

<div class="tooltip" id="tip"></div>

<div class="overlay" id="overlay">
  <button class="close-x" id="close-x">✕</button>
  <div class="sheet">
    <div class="phone"><div class="screen">
      <div class="notch"><i></i></div>
      <div class="ig-head"><span class="avatar"><i></i></span><span class="ig-user" id="ig-user"></span><span class="ig-dots">···</span></div>
      <div class="ig-media" id="ig-media"></div>
      <div class="ig-actions">
        <svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.6 8.6 0 0 1-3.9-.9L3 20l1.2-5.3a8.2 8.2 0 0 1-.7-3.2A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3z"/></svg>
        <svg viewBox="0 0 24 24"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
        <svg class="save" viewBox="0 0 24 24"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div class="ig-likes" id="ig-likes"></div>
      <div class="ig-cap" id="ig-cap"></div>
    </div></div>
    <div class="side">
      <span class="kw" id="m-kw"></span>
      <div class="stat" id="m-stat"></div>
      <div><div class="lbl">${c.modalGuide}</div><a class="guide-link" id="m-guide" target="_blank" rel="noopener"></a></div>
      <div class="thumbs" id="m-thumbs"></div>
      <a class="btn" id="m-open" target="_blank" rel="noopener">${c.modalOpen}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/></svg>
      </a>
    </div>
  </div>
</div>

<script>
const C = ${copyJson};
const HE = C.lang === "he";
const nf = new Intl.NumberFormat(HE ? "he-IL" : "en-US");
const $ = (id) => document.getElementById(id);
let DATA = null;

function rel(iso){
  if(!iso) return C.never;
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if(s < 90) return C.justNow;
  if(s < 3600) return fmtRel("minutes", Math.round(s/60));
  if(s < 86400) return fmtRel("hours", Math.round(s/3600));
  return fmtRel("days", Math.round(s/86400));
}
function fmtRel(unit, n){
  if(HE){
    if(unit==="minutes") return "לפני " + nf.format(n) + " דק׳";
    if(unit==="hours") return "לפני " + nf.format(n) + " שע׳";
    return n === 1 ? "אתמול" : "לפני " + nf.format(n) + " ימים";
  }
  if(unit==="minutes") return n + "m ago";
  if(unit==="hours") return n + "h ago";
  return n === 1 ? "yesterday" : n + "d ago";
}
function el(tag, cls, text){
  const node = document.createElement(tag);
  if(cls) node.className = cls;
  if(text !== undefined) node.textContent = text;
  return node;
}

function renderBadges(d){
  const box = $("badges"); box.textContent = "";
  const ok = d.totals.errors_24h === 0;
  const status = el("span", "badge " + (ok ? "ok" : "warn"));
  status.append(el("i","dot"), document.createTextNode(ok ? C.statusOk : C.statusIssues));
  box.append(status);
  box.append(el("span","badge", C.provider[d.service.provider] || d.service.provider));
  if(d.service.dry_run) box.append(el("span","badge", C.dryRun));
  if(d.service.follow_gate_enabled) box.append(el("span","badge", C.followGate));
}

function kpi(label, value, hero, colorClass){
  const box = el("div", "kpi" + (hero ? " hero" : ""));
  box.append(el("div","label",label));
  const v = el("div","value", nf.format(value));
  if(colorClass) v.style.color = colorClass;
  box.append(v);
  return box;
}
function renderKpis(d){
  const box = $("kpis"); box.textContent = "";
  box.append(
    kpi(C.kpiTotal, d.totals.delivered_total, true),
    kpi(C.kpiWeek, d.totals.delivered_7d),
    kpi(C.kpiToday, d.totals.delivered_today),
    kpi(C.kpiErrors, d.totals.errors_24h, false, d.totals.errors_24h ? "var(--bad)" : "var(--good)"),
  );
}

function renderChart(d){
  const box = $("chart"); box.textContent = "";
  const days = d.daily;
  const max = Math.max(...days.map(x=>x.delivered));
  if(max === 0){ box.append(el("div","empty",C.emptyChart)); renderChartTable(days); return; }
  const W = 720, H = 190, padB = 24, padT = 18, padX = 6;
  const bw = (W - padX*2) / days.length;
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  for(let g=1; g<=3; g++){
    const y = padT + (H - padB - padT) * (g/4);
    const line = document.createElementNS(svg.namespaceURI,"line");
    line.setAttribute("x1",padX); line.setAttribute("x2",W-padX);
    line.setAttribute("y1",y); line.setAttribute("y2",y);
    line.setAttribute("class","gridline");
    svg.append(line);
  }
  const maxIdx = days.reduce((best,x,i)=> x.delivered > days[best].delivered ? i : best, 0);
  days.forEach((x,i)=>{
    const h = x.delivered === 0 ? 2 : Math.max(4, (x.delivered/max)*(H-padB-padT));
    const bx = padX + i*bw + bw*0.18, bwid = bw*0.64, by = H - padB - h;
    const r = document.createElementNS(svg.namespaceURI,"rect");
    r.setAttribute("x",bx); r.setAttribute("y",by);
    r.setAttribute("width",bwid); r.setAttribute("height",h);
    r.setAttribute("rx",4); r.setAttribute("class","bar");
    if(x.delivered === 0) r.setAttribute("opacity","0.25");
    const dt = new Date(x.date + "T12:00:00");
    const label = dt.getDate() + "." + (dt.getMonth()+1);
    r.addEventListener("mousemove",(ev)=>{
      const tip = $("tip");
      tip.style.display = "block";
      tip.innerHTML = "";
      tip.append(el("span","",label + " · "), Object.assign(el("b","",nf.format(x.delivered)),{}));
      tip.style.left = Math.min(ev.clientX + 14, innerWidth - 120) + "px";
      tip.style.top = (ev.clientY - 40) + "px";
    });
    r.addEventListener("mouseleave",()=>{ $("tip").style.display="none"; });
    svg.append(r);
    if(i === maxIdx && x.delivered > 0){
      const t = document.createElementNS(svg.namespaceURI,"text");
      t.setAttribute("x", bx + bwid/2); t.setAttribute("y", by - 6);
      t.setAttribute("text-anchor","middle"); t.setAttribute("class","bar-label");
      t.textContent = nf.format(x.delivered);
      svg.append(t);
    }
    if(i % 2 === 0){
      const t = document.createElementNS(svg.namespaceURI,"text");
      t.setAttribute("x", bx + bwid/2); t.setAttribute("y", H - 7);
      t.setAttribute("text-anchor","middle"); t.setAttribute("class","axis-label");
      t.textContent = label;
      svg.append(t);
    }
  });
  box.append(svg);
  renderChartTable(days);
}
function renderChartTable(days){
  const box = $("chart-table"); box.textContent = "";
  const table = el("table");
  const head = el("tr"); head.append(el("th","",C.thDate), el("th","",C.thCount));
  table.append(head);
  for(const x of days){
    const tr = el("tr");
    tr.append(el("td","",x.date), el("td","",nf.format(x.delivered)));
    table.append(tr);
  }
  box.append(table);
}

const ROUTES_PER_PAGE = 5, FEED_PER_PAGE = 10;
let routesPage = 0, feedPage = 0;
function pager(total, perPage, page, onChange){
  const pages = Math.max(1, Math.ceil(total / perPage));
  if(pages < 2) return null;
  const box = el("div","pager");
  const prev = el("button","", HE ? "›" : "‹");
  const next = el("button","", HE ? "‹" : "›");
  prev.disabled = page === 0;
  next.disabled = page >= pages - 1;
  prev.addEventListener("click",()=>onChange(page - 1));
  next.addEventListener("click",()=>onChange(page + 1));
  box.append(prev, el("span","pg", nf.format(page + 1) + " / " + nf.format(pages)), next);
  return box;
}
function renderRoutes(d){
  const box = $("routes"); box.textContent = "";
  if(!d.routes.length){ box.append(el("div","empty",C.emptyRoutes)); return; }
  routesPage = Math.min(routesPage, Math.ceil(d.routes.length / ROUTES_PER_PAGE) - 1);
  for(const r of d.routes.slice(routesPage * ROUTES_PER_PAGE, (routesPage + 1) * ROUTES_PER_PAGE)){
    const row = el("button","route");
    row.append(el("span","kw",r.keyword));
    const mid = el("div","mid");
    mid.append(el("div","guide", r.guide_url || r.campaign_id));
    const meta = el("div","meta");
    if(r.requires_follow) meta.append(el("span","chip follow",C.requiresFollow));
    meta.append(el("span","chip", C.lastSent + ": " + rel(r.last_delivered_at)));
    mid.append(meta);
    row.append(mid);
    const num = el("div");
    num.append(el("div","num", nf.format(r.delivered_total)));
    num.append(el("div","when",C.delivered));
    num.style.textAlign = "center";
    row.append(num);
    row.append(el("span","arrow", HE ? "‹" : "›"));
    row.addEventListener("click",()=>openModal(r));
    box.append(row);
  }
  const pg = pager(d.routes.length, ROUTES_PER_PAGE, routesPage, (p)=>{ routesPage = p; renderRoutes(DATA); });
  if(pg) box.append(pg);
}

function statusInfo(evt){
  const s = evt.status;
  if(s === "sent") return { cls:"good", label:C.statusLabels.sent };
  if(s === "follow_gate_guide_sent") return { cls:"good", label:C.statusLabels.follow_gate_guide_sent };
  if(s === "message_sent" && evt.funnel_event === "cta_guide_delivered") return { cls:"good", label:C.statusLabels.message_sent_guide };
  if(s === "message_sent") return { cls:"info", label:C.statusLabels.message_sent };
  if(s === "follow_gate_reminder_sent") return { cls:"info", label:C.statusLabels.follow_gate_reminder_sent };
  if(s === "human_takeover_detected") return { cls:"mute", label:C.statusLabels.human_takeover_detected };
  if(s.endsWith("_error")) return { cls:"bad", label:C.statusLabels.error };
  return { cls:"mute", label:s };
}
function renderFeed(d){
  const box = $("feed"); box.textContent = "";
  if(!d.recent.length){ box.append(el("div","empty",C.emptyActivity)); return; }
  feedPage = Math.min(feedPage, Math.ceil(d.recent.length / FEED_PER_PAGE) - 1);
  for(const evt of d.recent.slice(feedPage * FEED_PER_PAGE, (feedPage + 1) * FEED_PER_PAGE)){
    const row = el("div","evt");
    const info = statusInfo(evt);
    row.append(el("i","dot " + info.cls));
    const what = el("span","what");
    if(evt.keyword){ what.append(el("b","kw-mini",evt.keyword), document.createTextNode(" · ")); }
    what.append(document.createTextNode(info.label));
    row.append(what);
    const t = el("time","",rel(evt.at));
    if(evt.at) t.title = new Date(evt.at).toLocaleString(HE ? "he-IL" : "en-US");
    row.append(t);
    box.append(row);
  }
  const pg = pager(d.recent.length, FEED_PER_PAGE, feedPage, (p)=>{ feedPage = p; renderFeed(DATA); });
  if(pg) box.append(pg);
}

let currentRoute = null;
function openModal(route){
  currentRoute = route;
  $("overlay").classList.add("open");
  $("m-kw").textContent = route.keyword;
  $("m-stat").innerHTML = "";
  const stat = el("div");
  const b = el("b","", nf.format(route.delivered_total));
  stat.append(b, document.createTextNode(" " + C.delivered));
  $("m-stat").append(stat);
  const guide = $("m-guide");
  if(route.guide_url && /^https?:/.test(route.guide_url)){ guide.href = route.guide_url; guide.textContent = route.guide_url; guide.parentElement.style.display=""; }
  else { guide.parentElement.style.display="none"; }
  renderThumbs(route);
  if(route.media.length) showMedia(route.media[0].media_id, route);
  else showNoMedia();
}
function showNoMedia(){
  document.querySelector(".screen").classList.remove("embed");
  $("ig-user").textContent = "";
  $("ig-likes").textContent = "";
  $("ig-cap").textContent = "";
  $("m-open").style.display = "none";
  const m = $("ig-media"); m.textContent = "";
  m.append(el("div","ph",C.modalNoMedia));
}
// Instagram's /embed/ endpoint is the one page Instagram serves without
// X-Frame-Options, so the real post can render inside the phone frame.
function embedUrlFor(permalink){
  try{
    const u = new URL(permalink);
    if(!/(^|\\.)instagram\\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\\/(p|reel|tv)\\/([A-Za-z0-9_-]+)/);
    if(!m) return null;
    return "https://www.instagram.com/" + m[1] + "/" + m[2] + "/embed/captioned/";
  }catch{ return null; }
}
function renderThumbs(route){
  const box = $("m-thumbs"); box.textContent = "";
  if(route.media.length < 2) return;
  route.media.forEach((m,i)=>{
    const btn = el("button", i===0 ? "on" : "");
    btn.dataset.mediaId = m.media_id;
    btn.title = nf.format(m.delivered);
    btn.addEventListener("click",()=>{
      box.querySelectorAll("button").forEach(x=>x.classList.remove("on"));
      btn.classList.add("on");
      showMedia(m.media_id, route);
    });
    box.append(btn);
    fetch("/dashboard/api/media/" + m.media_id)
      .then((res)=>res.ok ? res.json() : null)
      .then((data)=>{
        const md = data && data.media;
        if(!md || btn.querySelector("img")) return;
        const src = md.media_type === "VIDEO" ? (md.thumbnail_url || md.media_url) : (md.media_url || md.thumbnail_url);
        if(src){ const img = el("img"); img.src = src; btn.append(img); }
      })
      .catch(()=>{});
  });
}
async function showMedia(mediaId, route){
  document.querySelector(".screen").classList.remove("embed");
  const m = $("ig-media"); m.textContent = "";
  m.append(el("div","spin"));
  $("m-open").style.display = "none";
  try{
    const res = await fetch("/dashboard/api/media/" + mediaId);
    if(!res.ok) throw new Error("fetch failed");
    const { media } = await res.json();
    if(currentRoute !== route) return;
    const screen = document.querySelector(".screen");
    const embedUrl = media.permalink ? embedUrlFor(media.permalink) : null;
    const src = media.media_type === "VIDEO" ? (media.thumbnail_url || media.media_url) : (media.media_url || media.thumbnail_url);
    if(embedUrl){
      // the real post, rendered by Instagram inside the phone
      screen.classList.add("embed");
      m.textContent = "";
      const frame = document.createElement("iframe");
      frame.src = embedUrl;
      frame.setAttribute("scrolling","yes");
      frame.setAttribute("loading","lazy");
      frame.setAttribute("sandbox","allow-scripts allow-same-origin allow-popups");
      m.append(frame);
    } else {
      // fallback: static mock built from the cached metadata
      screen.classList.remove("embed");
      $("ig-user").textContent = media.username || "";
      $("ig-likes").textContent = media.like_count != null
        ? nf.format(media.like_count) + " " + C.likes + (media.comments_count != null ? " · " + nf.format(media.comments_count) + " " + C.comments : "")
        : "";
      renderCaption(media.caption, route.keyword);
      m.textContent = "";
      if(src){
        const img = el("img");
        img.src = src; img.alt = "";
        img.addEventListener("error",()=>{ m.textContent=""; m.append(el("div","ph",C.modalMediaError)); });
        m.append(img);
      } else {
        m.append(el("div","ph",C.modalMediaError));
      }
    }
    const thumbBtn = document.querySelector('#m-thumbs button[data-media-id="'+mediaId+'"]');
    if(thumbBtn && src && !thumbBtn.querySelector("img")){
      const timg = el("img"); timg.src = src; thumbBtn.append(timg);
    }
    if(media.permalink){ $("m-open").href = media.permalink; $("m-open").style.display = ""; }
    const perMedia = route.media.find(x=>x.media_id === mediaId);
    if(perMedia){
      $("m-stat").textContent = "";
      const stat = el("div");
      stat.append(el("b","", nf.format(perMedia.delivered)), document.createTextNode(" " + (HE ? "מדריכים נשלחו מהפוסט הזה" : "guides delivered from this post")));
      const total = el("div","lbl");
      total.textContent = (HE ? "סה\\"כ באוטומציה: " : "Automation total: ") + nf.format(route.delivered_total);
      $("m-stat").append(stat, total);
    }
  } catch {
    if(currentRoute !== route) return;
    m.textContent = "";
    m.append(el("div","ph",C.modalMediaError));
  }
}
function renderCaption(caption, keyword){
  const box = $("ig-cap"); box.textContent = "";
  if(!caption) return;
  const short = caption.length > 300 ? caption.slice(0,300) + "…" : caption;
  const rx = new RegExp("(" + keyword.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&") + ")","gi");
  short.split(rx).forEach((part)=>{
    if(part.toUpperCase() === keyword.toUpperCase()) box.append(el("mark","",part));
    else box.append(document.createTextNode(part));
  });
}
function closeModal(){ $("overlay").classList.remove("open"); currentRoute = null; }
$("close-x").addEventListener("click",closeModal);
$("overlay").addEventListener("click",(e)=>{ if(e.target === $("overlay")) closeModal(); });
addEventListener("keydown",(e)=>{ if(e.key === "Escape") closeModal(); });

async function refresh(){
  try{
    const res = await fetch("/dashboard/api/summary");
    if(!res.ok) return;
    DATA = await res.json();
    renderBadges(DATA); renderKpis(DATA); renderChart(DATA); renderRoutes(DATA); renderFeed(DATA);
    $("updated").textContent = C.updated + " " + new Date().toLocaleTimeString(HE ? "he-IL" : "en-US", {hour:"2-digit",minute:"2-digit"});
    $("version").textContent = "Instagram CTA Kit v" + DATA.service.version;
  }catch{ /* keep last render */ }
}
refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}
