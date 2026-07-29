import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

const QUEUE_DIRS = ["pending", "processing", "completed", "resolved", "dead-letter"];

function eventKeyFor(event) {
  const type = String(event?.type || "");
  const externalId = String(event?.external_id || "");
  if (!type || !externalId) throw new Error("Inbox event requires type and external_id");
  return createHash("sha256").update(`${type}:${externalId}`).digest("hex");
}

async function syncDirectory(path) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWriteJson(directory, filename, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, filename);
  const temporary = join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await syncDirectory(directory);
  return target;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function safeError(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1_000);
}

function errorMetadata(error) {
  const metadata = {};
  if (error?.code) metadata.error_code = String(error.code).slice(0, 100);
  if (Number.isFinite(Number(error?.status))) metadata.error_status = Number(error.status);
  if (Number.isFinite(Number(error?.metaCode))) {
    metadata.error_provider_code = Number(error.metaCode);
  }
  if (Number.isFinite(Number(error?.metaSubcode))) {
    metadata.error_provider_subcode = Number(error.metaSubcode);
  }
  if (typeof error?.metaIsTransient === "boolean") {
    metadata.error_provider_transient = error.metaIsTransient;
  }
  return metadata;
}

export function createDurableInbox({ rootDir, now = Date.now }) {
  if (!rootDir) throw new Error("Durable inbox requires rootDir");
  let operation = Promise.resolve();
  const paths = Object.fromEntries(QUEUE_DIRS.map((name) => [name, join(rootDir, name)]));

  const locked = (callback) => {
    const result = operation.then(callback, callback);
    operation = result.catch(() => {});
    return result;
  };

  const initialize = async () => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await chmod(rootDir, 0o700);
    for (const directory of Object.values(paths)) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
  };

  const findLocation = async (eventKey) => {
    const filename = `${eventKey}.json`;
    for (const name of QUEUE_DIRS) {
      if (await fileExists(join(paths[name], filename))) return name;
    }
    return null;
  };

  return {
    async enqueue(event) {
      return locked(async () => {
        await initialize();
        const eventKey = eventKeyFor(event);
        if (await findLocation(eventKey)) return { eventKey, duplicate: true };
        const createdAt = new Date(now()).toISOString();
        await atomicWriteJson(paths.pending, `${eventKey}.json`, {
          ...event,
          event_key: eventKey,
          created_at: createdAt,
          attempts: 0,
          next_attempt_at: null,
          last_error: null,
        });
        return { eventKey, duplicate: false };
      });
    },

    async claimNext() {
      return locked(async () => {
        await initialize();
        const due = [];
        for (const filename of (await readdir(paths.pending)).filter((name) => name.endsWith(".json"))) {
          const event = await readJson(join(paths.pending, filename));
          const nextAttempt = event.next_attempt_at ? Date.parse(event.next_attempt_at) : 0;
          if (Number.isFinite(nextAttempt) && nextAttempt > now()) continue;
          due.push({ filename, event });
        }
        due.sort((a, b) => (
          Date.parse(a.event.received_at || a.event.created_at || 0)
          - Date.parse(b.event.received_at || b.event.created_at || 0)
        ));
        const next = due[0];
        if (!next) return null;
        await rename(join(paths.pending, next.filename), join(paths.processing, next.filename));
        await syncDirectory(paths.pending);
        await syncDirectory(paths.processing);
        return { eventKey: next.event.event_key, event: next.event };
      });
    },

    async complete(claim, result = {}) {
      return locked(async () => {
        await initialize();
        const filename = `${claim.eventKey}.json`;
        const completed = {
          event_key: claim.eventKey,
          type: claim.event.type,
          external_id: claim.event.external_id,
          received_at: claim.event.received_at,
          completed_at: new Date(now()).toISOString(),
          attempts: claim.event.attempts,
          status: result.status || "completed",
          ...(result.keyword ? { keyword: result.keyword } : {}),
        };
        await atomicWriteJson(paths.completed, filename, completed);
        await rm(join(paths.processing, filename), { force: true });
        await syncDirectory(paths.processing);
        return completed;
      });
    },

    async retry(claim, error, nextAttemptAt) {
      return locked(async () => {
        await initialize();
        const filename = `${claim.eventKey}.json`;
        await atomicWriteJson(paths.pending, filename, {
          ...claim.event,
          attempts: Number(claim.event.attempts || 0) + 1,
          next_attempt_at: nextAttemptAt,
          last_error: safeError(error),
          ...errorMetadata(error),
        });
        await rm(join(paths.processing, filename), { force: true });
        await syncDirectory(paths.processing);
      });
    },

    async deadLetter(claim, error) {
      return locked(async () => {
        await initialize();
        const filename = `${claim.eventKey}.json`;
        await atomicWriteJson(paths["dead-letter"], filename, {
          ...claim.event,
          attempts: Number(claim.event.attempts || 0) + 1,
          failed_at: new Date(now()).toISOString(),
          last_error: safeError(error),
          ...errorMetadata(error),
        });
        await rm(join(paths.processing, filename), { force: true });
        await syncDirectory(paths.processing);
      });
    },

    async replay(eventKey) {
      return locked(async () => {
        await initialize();
        const filename = `${eventKey}.json`;
        const source = join(paths["dead-letter"], filename);
        if (!await fileExists(source) || await fileExists(join(paths.resolved, filename))) return false;
        const event = await readJson(source);
        await atomicWriteJson(paths.pending, filename, {
          ...event,
          attempts: 0,
          next_attempt_at: null,
          last_error: null,
          replayed_at: new Date(now()).toISOString(),
        });
        await rm(source, { force: true });
        await syncDirectory(paths["dead-letter"]);
        return true;
      });
    },

    async resolveDeadLetter(eventKey, reason) {
      return locked(async () => {
        await initialize();
        const filename = `${eventKey}.json`;
        const source = join(paths["dead-letter"], filename);
        if (!await fileExists(source)) return false;
        const event = await readJson(source);
        await atomicWriteJson(paths.resolved, filename, {
          event_key: eventKey,
          type: event.type || null,
          external_id: event.external_id || null,
          failed_at: event.failed_at || null,
          resolved_at: new Date(now()).toISOString(),
          resolution: "permanent_failure_acknowledged",
          reason: String(reason || "").slice(0, 500),
          attempts: Number(event.attempts || 0),
          last_error: event.last_error || null,
          error_code: event.error_code || null,
          error_status: event.error_status || null,
          error_provider_code: event.error_provider_code || null,
          error_provider_subcode: event.error_provider_subcode || null,
        });
        await rm(source, { force: true });
        await syncDirectory(paths["dead-letter"]);
        return true;
      });
    },

    async listDeadLetters({ limit = 50 } = {}) {
      return locked(async () => {
        await initialize();
        const filenames = (await readdir(paths["dead-letter"]))
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .sort()
          .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
        return Promise.all(filenames.map(async (filename) => {
          const event = await readJson(join(paths["dead-letter"], filename));
          return {
            event_key: filename.slice(0, -5),
            type: event.type || null,
            external_id: event.external_id || null,
            attempts: Number(event.attempts || 0),
            failed_at: event.failed_at || null,
            last_error: event.last_error || null,
            error_code: event.error_code || null,
            error_status: event.error_status || null,
            error_provider_code: event.error_provider_code || null,
            error_provider_subcode: event.error_provider_subcode || null,
          };
        }));
      });
    },

    async recoverInterrupted() {
      return locked(async () => {
        await initialize();
        let recovered = 0;
        for (const filename of (await readdir(paths.processing)).filter((name) => name.endsWith(".json"))) {
          const source = join(paths.processing, filename);
          const terminal = await fileExists(join(paths.completed, filename))
            || await fileExists(join(paths["dead-letter"], filename))
            || await fileExists(join(paths.resolved, filename));
          if (terminal || await fileExists(join(paths.pending, filename))) {
            await rm(source, { force: true });
          } else {
            await rename(source, join(paths.pending, filename));
          }
          recovered += 1;
        }
        if (recovered > 0) {
          await syncDirectory(paths.processing);
          await syncDirectory(paths.pending);
        }
        return recovered;
      });
    },

    async summary() {
      return locked(async () => {
        await initialize();
        const counts = {};
        for (const name of QUEUE_DIRS) {
          counts[name] = (await readdir(paths[name])).filter((file) => file.endsWith(".json")).length;
        }
        let oldestPendingAt = null;
        for (const filename of (await readdir(paths.pending)).filter((file) => file.endsWith(".json"))) {
          const event = await readJson(join(paths.pending, filename));
          const timestamp = event.received_at || event.created_at || null;
          if (timestamp && (!oldestPendingAt || Date.parse(timestamp) < Date.parse(oldestPendingAt))) {
            oldestPendingAt = timestamp;
          }
        }
        return {
          pending_count: counts.pending,
          processing_count: counts.processing,
          completed_count: counts.completed,
          dead_letter_count: counts["dead-letter"],
          resolved_count: counts.resolved,
          oldest_pending_at: oldestPendingAt,
        };
      });
    },
  };
}
