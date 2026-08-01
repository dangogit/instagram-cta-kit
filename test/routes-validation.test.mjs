import assert from "node:assert/strict";
import {
  formatFailure,
  formatSkippedGuideChecks,
  isExampleGuideUrl,
  validateRoutes,
} from "../src/routes-validation.mjs";

function route(overrides = {}) {
  const guideUrl = overrides.guide_url || "https://real.example-site.test-not-reserved.com/guide";
  return {
    keyword: "GUIDE",
    campaign_id: "a-guide",
    guide_url: guideUrl,
    reply_text: `Here is the guide:\n${guideUrl}`,
    ...overrides,
  };
}

function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch for ${url}`);
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, body: null };
  };
  return { fetchImpl, calls };
}

// Reserved documentation and special-use names are placeholders, never live pages.
for (const url of [
  "https://example.com/guide",
  "https://example.com/he/guide",
  "https://www.example.com/guide",
  "https://example.net/x",
  "https://example.org/x",
  "https://anything.example/x",
  "https://host.invalid/x",
  "https://host.test/x",
  "https://EXAMPLE.COM/Guide",
]) {
  assert.equal(isExampleGuideUrl(url), true, `expected placeholder: ${url}`);
}
for (const url of [
  "https://danielthegoldman.com/guides/x",
  "https://myexample.com/guide",
  "https://example.company.com/guide",
  "not a url",
]) {
  assert.equal(isExampleGuideUrl(url), false, `expected real URL: ${url}`);
}

// Example routes seeded by init are skipped instead of failing the guide check.
{
  const { fetchImpl, calls } = stubFetch([]);
  const routes = [
    route({ keyword: "GUIDE", guide_url: "https://example.com/guide", reply_text: "Here: https://example.com/guide" }),
    route({ keyword: "מדריך", campaign_id: "hebrew-guide", guide_url: "https://example.com/he/guide", reply_text: "כאן: https://example.com/he/guide" }),
  ];
  const report = await validateRoutes(routes, { checkGuides: true, fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.equal(calls.length, 0, "placeholder URLs must not be fetched");
  assert.equal(report.skippedGuideChecks.length, 2);
  assert.deepEqual(report.exampleRoutes.map((entry) => entry.keyword), ["GUIDE", "מדריך"]);
  assert.match(report.warnings.join("\n"), /GUIDE still points at the placeholder URL/);
  assert.match(report.warnings.join("\n"), /instagram-cta route remove GUIDE/);
  assert.match(formatSkippedGuideChecks(report.skippedGuideChecks), /skipped guide check for 2 example routes: GUIDE, מדריך/);
}

// A real URL that 404s reports the keyword, the URL, and the status.
{
  const { fetchImpl, calls } = stubFetch([{ status: 404 }]);
  const report = await validateRoutes([route({ keyword: "DEADLINK" })], { checkGuides: true, fetchImpl });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /^DEADLINK guide_url https:\/\/\S+ returned HTTP 404$/);
  assert.equal(calls[0].method, "HEAD");
  assert.equal(report.skippedGuideChecks.length, 0);
}

// HEAD rejected with 405 falls back to GET.
{
  const { fetchImpl, calls } = stubFetch([{ status: 405 }, { status: 200 }]);
  const report = await validateRoutes([route()], { checkGuides: true, fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(calls.map((call) => call.method), ["HEAD", "GET"]);
}

// A network failure is reported, not thrown as an unhandled rejection.
{
  const { fetchImpl } = stubFetch([new Error("getaddrinfo ENOTFOUND")]);
  const report = await validateRoutes([route({ keyword: "OFFLINE" })], { checkGuides: true, fetchImpl });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /OFFLINE guide_url .* could not be reached: getaddrinfo ENOTFOUND/);
}

// Guide checks only run when asked for.
{
  const { fetchImpl, calls } = stubFetch([]);
  const report = await validateRoutes([route()], { checkGuides: false, fetchImpl });
  assert.deepEqual(report.errors, []);
  assert.equal(calls.length, 0);
}

// Existing structural checks still fail as before.
{
  const report = await validateRoutes([
    route({ keyword: "A!", campaign_id: "Bad Slug", guide_url: "http://insecure.example-real.com/x", reply_text: "" }),
  ]);
  const joined = report.errors.join("\n");
  assert.match(joined, /bad keyword/);
  assert.match(joined, /campaign_id must be a stable asset slug/);
  assert.match(joined, /guide_url must be a valid https URL/);
  assert.match(joined, /reply_text is required/);
}

// Failure output is human readable: numbered problems, no assertion internals.
{
  const output = formatFailure({
    errors: ["GUIDE guide_url https://example.com/guide returned HTTP 404"],
    exampleRoutes: [{ keyword: "GUIDE", url: "https://example.com/guide" }],
    routesFile: "/tmp/routes.json",
  });
  assert.match(output, /routes validation failed: 1 problem/);
  assert.match(output, /1\. GUIDE guide_url/);
  assert.match(output, /routes file: \/tmp\/routes\.json/);
  assert.match(output, /created by instagram-cta init/);
  assert.match(output, /instagram-cta route remove GUIDE/);
  assert.doesNotMatch(output, /AssertionError|ERR_ASSERTION|at file:\/\/|generatedMessage/);
}

console.log("routes-validation.test.mjs passed");
