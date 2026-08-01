// Route validation shared by scripts/validate-routes.mjs and the test suite.
// Kept free of process exits and console output so failures can be formatted
// for humans instead of surfacing as raw assertion stack traces.

// Reserved documentation names (RFC 2606) and special-use names (RFC 6761).
// A guide_url on one of these is a placeholder, never a live page.
const RESERVED_EXAMPLE_HOSTS = ["example.com", "example.net", "example.org"];
const RESERVED_EXAMPLE_SUFFIXES = [".example", ".invalid", ".test", ".localhost"];

export function normalizeKeyword(value) {
  return String(value || "").trim().toUpperCase();
}

export function isExampleGuideUrl(value) {
  let hostname;
  try {
    hostname = new URL(String(value)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (RESERVED_EXAMPLE_HOSTS.includes(hostname)) return true;
  if (RESERVED_EXAMPLE_HOSTS.some((host) => hostname.endsWith(`.${host}`))) return true;
  return RESERVED_EXAMPLE_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

export function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
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

export function activeRoutes(parsed) {
  const list = Array.isArray(parsed?.routes) ? parsed.routes : [];
  return list.filter((route) => route.active !== false);
}

async function checkGuideUrl(route, fetchImpl) {
  let response = await fetchImpl(route.guide_url, {
    method: "HEAD",
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 405) {
    response = await fetchImpl(route.guide_url, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
  }
  return response;
}

export async function validateRoutes(routes, { checkGuides = false, fetchImpl = fetch } = {}) {
  const errors = [];
  const warnings = [];
  const exampleRoutes = [];
  const skippedGuideChecks = [];

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

    if (isExampleGuideUrl(route.guide_url)) {
      exampleRoutes.push({ keyword, url: String(route.guide_url) });
      warnings.push(`${keyword} still points at the placeholder URL ${route.guide_url}; replace it with your own guide or run: instagram-cta route remove ${route.keyword}`);
    }
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

  if (checkGuides) {
    for (const route of routes) {
      const keyword = normalizeKeyword(route.keyword);
      if (!validHttpsUrl(route.guide_url)) continue;
      if (isExampleGuideUrl(route.guide_url)) {
        skippedGuideChecks.push({ keyword, url: String(route.guide_url) });
        continue;
      }
      try {
        const response = await checkGuideUrl(route, fetchImpl);
        if (!response.ok) errors.push(`${keyword} guide_url ${route.guide_url} returned HTTP ${response.status}`);
      } catch (error) {
        errors.push(`${keyword} guide_url ${route.guide_url} could not be reached: ${error.message}`);
      }
    }
  }

  return { errors, warnings, exampleRoutes, skippedGuideChecks };
}

function listKeywords(entries) {
  return entries.map((entry) => entry.keyword).join(", ");
}

export function formatExampleRouteHint(exampleRoutes) {
  if (!exampleRoutes.length) return "";
  const first = exampleRoutes[0].keyword;
  const plural = exampleRoutes.length > 1;
  return [
    `note: ${listKeywords(exampleRoutes)} ${plural ? "are example routes" : "is an example route"} created by instagram-cta init.`,
    `${plural ? "They point" : "It points"} at a placeholder domain and will never resolve, so the guide check skips ${plural ? "them" : "it"}.`,
    `Point ${plural ? "them" : "it"} at your own guide, or remove ${plural ? "them" : "it"}: instagram-cta route remove ${first}`,
  ].join("\n");
}

export function formatSkippedGuideChecks(skippedGuideChecks) {
  if (!skippedGuideChecks.length) return "";
  const plural = skippedGuideChecks.length > 1;
  return `skipped guide check for ${skippedGuideChecks.length} example ${plural ? "routes" : "route"}: ${listKeywords(skippedGuideChecks)}`;
}

export function formatFailure({ errors, exampleRoutes = [], routesFile = "" }) {
  const lines = [
    `routes validation failed: ${errors.length} ${errors.length === 1 ? "problem" : "problems"}`,
    "",
    ...errors.map((error, index) => `  ${index + 1}. ${error}`),
  ];
  if (routesFile) lines.push("", `routes file: ${routesFile}`);
  const hint = formatExampleRouteHint(exampleRoutes);
  if (hint) lines.push("", hint);
  lines.push("", "Fix the routes above, then run the command again.");
  return lines.join("\n");
}
