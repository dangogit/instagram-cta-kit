import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(body, header, secrets, { dryRun = false } = {}) {
  if (dryRun) return true;
  const candidates = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (candidates.length === 0 || !header?.startsWith("sha256=")) return false;
  const suppliedHex = header.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const supplied = Buffer.from(suppliedHex, "hex");
  return candidates.some((secret) => {
    const expected = createHmac("sha256", secret).update(body).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
