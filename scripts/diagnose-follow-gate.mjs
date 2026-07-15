#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function loadDotEnv() {
  let raw = "";
  try {
    raw = await readFile(resolve(process.cwd(), ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    process.env[key] = valueParts.join("=").replace(/^"|"$/g, "");
  }
}

function eventTime(event) {
  const time = new Date(event.at || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function eventKey(event) {
  if (!event.from_id || !event.media_id || !event.keyword) return null;
  return `${event.from_id}:${event.media_id}:${event.keyword}`;
}

async function readEvents() {
  const stateFile = resolve(process.cwd(), process.env.STATE_FILE || "./state/events.jsonl");
  let raw = "";
  try {
    raw = await readFile(stateFile, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function pendingFromEvents(events) {
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
    const key = eventKey(event);
    if (event.follower_state === true || event.status === "follow_gate_guide_sent") {
      if (key) pending.delete(key);
      for (const [pendingKey, pendingEvent] of pending) {
        if (String(pendingEvent.from_id) === String(event.from_id) && eventTime(pendingEvent) <= eventTime(event)) {
          pending.delete(pendingKey);
        }
      }
      continue;
    }
    if (!key) continue;
    if (!pendingStatuses.has(event.status)) continue;
    const current = pending.get(key);
    if (current && eventTime(current) > eventTime(event)) continue;
    pending.set(key, event);
  }

  const latestByUser = new Map();
  for (const event of pending.values()) {
    const current = latestByUser.get(event.from_id);
    if (!current || eventTime(event) > eventTime(current)) {
      latestByUser.set(event.from_id, event);
    }
  }
  return [...latestByUser.values()];
}

async function graphGet(path, params = {}) {
  const base = process.env.GRAPH_BASE_URL || "https://graph.instagram.com/v25.0";
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${process.env.IG_ACCESS_TOKEN || ""}` },
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

await loadDotEnv();

if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) {
  throw new Error("Missing IG_USER_ID or IG_ACCESS_TOKEN");
}

const account = await graphGet(process.env.IG_USER_ID, { fields: "id,username,name,account_type" });
const pending = pendingFromEvents(await readEvents());
const users = [];

for (const event of pending) {
  const follower = await graphGet(event.from_id, { fields: "is_user_follow_business" });
  const followerState = follower.data?.is_user_follow_business;
  users.push({
    from_tail: String(event.from_id).slice(-6),
    media_id: event.media_id,
    keyword: event.keyword,
    last_status: event.status,
    last_at: event.at || null,
    follower_state: typeof followerState === "boolean" ? followerState : null,
    next_action: followerState === true ? "send_guide_on_background_gate" : "wait_for_follow_or_user_action",
    lookup_ok: follower.ok,
    lookup_status: follower.status,
  });
}

console.log(JSON.stringify({
  account: account.data,
  pending_count: users.length,
  pending: users,
}, null, 2));
