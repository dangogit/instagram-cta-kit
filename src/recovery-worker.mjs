import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

const PERMANENT_PROVIDER_SUBCODES = new Set([2534014, 2534066]);

async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function resultSummary(result) {
  const rows = Array.isArray(result) ? result : [result];
  const failure = rows.find((entry) => (
    ["error", "dm_error", "message_error", "follow_gate_error", "public_reply_error"]
      .includes(entry?.status)
  ));
  if (failure) {
    const error = new Error(failure.error || "CTA delivery returned an error result");
    error.code = failure.error_code || "CTA_DELIVERY_ERROR";
    error.status = failure.error_status;
    error.metaCode = failure.error_provider_code;
    error.metaSubcode = failure.error_provider_subcode;
    error.metaIsTransient = failure.error_provider_transient === true;
    throw error;
  }
  const first = rows.find(Boolean) || {};
  const summary = {
    ...first,
    status: first.status || "completed",
  };
  if (!first.keyword) delete summary.keyword;
  return summary;
}

function isPermanent(error) {
  return PERMANENT_PROVIDER_SUBCODES.has(Number(error?.metaSubcode))
    && error?.metaIsTransient !== true;
}

export function createRecoveryWorker({
  inbox,
  processEvent,
  statusFile,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  maxAttempts = 5,
  retryBaseMs = 30_000,
  intervalMs = 1_000,
}) {
  if (!inbox || !processEvent || !statusFile) {
    throw new Error("Recovery worker requires inbox, processEvent, and statusFile");
  }
  let running = false;
  let started = false;
  let timer = null;
  let operation = Promise.resolve();
  const status = {
    started: false,
    last_run_at: null,
    last_result: null,
    last_error: null,
    recovered_interrupted_count: 0,
  };

  const persist = () => atomicWriteJson(statusFile, { version: 1, ...status });
  const exclusive = (callback) => {
    const result = operation.then(callback, callback);
    operation = result.catch(() => {});
    return result;
  };

  const load = async () => {
    try {
      const saved = JSON.parse(await readFile(statusFile, "utf8"));
      Object.assign(status, saved, { started });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };

  const runDueUnlocked = async ({ limit = 25 } = {}) => {
    running = true;
    const counts = {
      processed: 0,
      completed: 0,
      retried: 0,
      dead_lettered: 0,
      results: [],
    };
    try {
      for (let index = 0; index < limit; index += 1) {
        const claim = await inbox.claimNext();
        if (!claim) break;
        counts.processed += 1;
        try {
          const summary = resultSummary(await processEvent(claim.event));
          await inbox.complete(claim, summary);
          counts.completed += 1;
          counts.results.push({
            event_key: claim.eventKey,
            type: claim.event.type,
            external_id: claim.event.external_id,
            ...summary,
          });
        } catch (error) {
          const attempts = Number(claim.event.attempts || 0) + 1;
          if (isPermanent(error) || attempts >= maxAttempts) {
            await inbox.deadLetter(claim, error);
            counts.dead_lettered += 1;
          } else {
            const delay = Math.min(60 * 60 * 1000, retryBaseMs * (2 ** (attempts - 1)));
            await inbox.retry(claim, error, new Date(now() + delay).toISOString());
            counts.retried += 1;
          }
          counts.results.push({
            event_key: claim.eventKey,
            type: claim.event.type,
            external_id: claim.event.external_id,
            ...(claim.event.type === "comment"
              ? { commentId: claim.event.external_id }
              : { messageId: claim.event.external_id }),
            status: isPermanent(error) || attempts >= maxAttempts ? "dead_lettered" : "retry_scheduled",
            error: String(error?.message || error).slice(0, 1_000),
          });
          status.last_error = String(error?.message || error).slice(0, 1_000);
        }
      }
      status.last_run_at = new Date(now()).toISOString();
      status.last_result = counts;
      if (counts.retried === 0 && counts.dead_lettered === 0) status.last_error = null;
      await persist();
      return counts;
    } finally {
      running = false;
    }
  };
  const runDue = (options = {}) => exclusive(() => runDueUnlocked(options));

  const recoverInterrupted = () => exclusive(async () => {
    running = true;
    try {
      const recovered = await inbox.recoverInterrupted();
      status.recovered_interrupted_count += recovered;
      await persist();
      return recovered;
    } finally {
      running = false;
    }
  });

  const tick = async () => {
    if (!started) return;
    try {
      await runDue();
    } catch (error) {
      status.last_error = String(error?.message || error).slice(0, 1_000);
      await persist();
    } finally {
      if (started) {
        timer = schedule(tick, intervalMs);
        timer?.unref?.();
      }
    }
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await load();
      status.started = true;
      await recoverInterrupted();
      timer = schedule(tick, 0);
      timer?.unref?.();
    },
    stop() {
      started = false;
      status.started = false;
      if (timer !== null) cancel(timer);
      timer = null;
    },
    runDue,
    recoverInterrupted,
    snapshot() {
      return { running, ...status };
    },
  };
}
