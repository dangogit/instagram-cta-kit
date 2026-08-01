#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeKeyword } from "../src/routes-validation.mjs";

const args = process.argv.slice(2);
const keywordArg = args.shift();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.error(`Usage:
  instagram-cta route remove KEYWORD [--media-id MEDIA_ID] [--all]

Options:
  --media-id MEDIA_ID  remove only the route scoped to this post
  --all                remove every route that uses this keyword`);
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

function routeMediaIds(route) {
  const value = route.media_ids || route.mediaIds || [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

function describeMediaIds(route) {
  const ids = routeMediaIds(route);
  return ids.length ? `--media-id ${ids.join(" or --media-id ")}` : "no media_ids (matches every post)";
}

if (!keywordArg) usage();

const keyword = normalizeKeyword(keywordArg);
const mediaId = takeFlag("--media-id");
const removeAll = hasFlag("--all");
if (args.length) usage();

const routesFile = resolve(process.cwd(), process.env.ROUTES_FILE || "./routes.json");

let parsed;
try {
  parsed = JSON.parse(await readFile(routesFile, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") fail(`routes file not found: ${routesFile}\nRun instagram-cta init first, or pass --dir with the folder that holds routes.json.`);
  if (error instanceof SyntaxError) fail(`routes file is not valid JSON: ${routesFile}\n${error.message}`);
  fail(`routes file could not be read: ${routesFile}\n${error.message}`);
}
if (!Array.isArray(parsed.routes)) parsed.routes = [];

let matches = parsed.routes.filter((route) => normalizeKeyword(route.keyword) === keyword);

if (!matches.length) {
  const aliasOwners = parsed.routes.filter((route) => (route.aliases || []).some((alias) => normalizeKeyword(alias) === keyword));
  if (aliasOwners.length) {
    fail(`${keyword} is an alias of ${aliasOwners.map((route) => normalizeKeyword(route.keyword)).join(", ")}, not a route of its own.\nRemove the route by its keyword, or drop the alias by editing ${routesFile}.`);
  }
  const available = parsed.routes.map((route) => normalizeKeyword(route.keyword)).filter(Boolean);
  fail(`${keyword} is not in ${routesFile}.\n${available.length ? `Keywords in this file: ${available.join(", ")}` : "This file has no routes."}`);
}

if (mediaId) {
  matches = matches.filter((route) => routeMediaIds(route).includes(String(mediaId)));
  if (!matches.length) fail(`${keyword} has no route scoped to media_id ${mediaId}.`);
}

if (matches.length > 1 && !removeAll) {
  const options = matches.map((route) => `  - ${route.guide_url} (${describeMediaIds(route)})`).join("\n");
  fail(`${keyword} matches ${matches.length} routes:\n${options}\nPick one with --media-id MEDIA_ID, or remove all of them with --all.`);
}

const removed = new Set(matches);
parsed.routes = parsed.routes.filter((route) => !removed.has(route));
await writeFile(routesFile, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

for (const route of matches) console.log(`removed ${normalizeKeyword(route.keyword)} -> ${route.guide_url}`);
console.log(`routes left: ${parsed.routes.length}`);
