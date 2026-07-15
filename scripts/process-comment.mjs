#!/usr/bin/env node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`Usage:
  npm run process:comment -- COMMENT_ID --media-id MEDIA_ID [--send]

Default is dry-run. Add --send only for an approved real Instagram test comment.`);
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

async function loadEnvFile(path = ".env") {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index);
    let value = trimmed.slice(index + 1);
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const commentId = args.shift();
const mediaId = takeFlag("--media-id");
const send = hasFlag("--send");
if (!commentId || !mediaId || args.length) usage();

await loadEnvFile();
process.env.ROUTES_FILE = process.env.ROUTES_FILE || "./routes.json";
process.env.STATE_FILE = process.env.STATE_FILE || "./state/events.jsonl";
if (!send) {
  process.env.DRY_RUN = "1";
  const tmp = await mkdtemp(join(tmpdir(), "instagram-cta-process-"));
  process.env.STATE_FILE = join(tmp, "events.jsonl");
}

const graphBaseUrl = process.env.GRAPH_BASE_URL || "https://graph.instagram.com/v25.0";
const accessToken = process.env.IG_ACCESS_TOKEN;
const igUserId = process.env.IG_USER_ID;
if (!accessToken || !igUserId) throw new Error("Missing IG_ACCESS_TOKEN or IG_USER_ID");

async function graphGet(path, params = {}) {
  const url = new URL(`${graphBaseUrl}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta read failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const comment = await graphGet(commentId, {
  fields: "id,text,timestamp,username,from",
});

const { processComments } = await import(resolve(process.cwd(), "src/server.mjs"));
const results = await processComments([
  {
    igUserId,
    commentId: String(comment.id),
    mediaId: String(mediaId),
    text: String(comment.text || ""),
    fromId: comment.from?.id || null,
    followerState: null,
    raw: comment,
  },
]);

console.log(JSON.stringify({
  mode: send ? "send" : "dry-run",
  comment: {
    id: comment.id,
    text: comment.text,
    username: comment.username || comment.from?.username || null,
    timestamp: comment.timestamp || null,
  },
  results,
}, null, 2));
