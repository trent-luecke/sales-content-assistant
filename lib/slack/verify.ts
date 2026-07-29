import crypto from "node:crypto";

export function verifySlackSignature(params: {
  signingSecret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  now?: number;
}): boolean {
  const { signingSecret, signature, timestamp, rawBody } = params;
  if (!signature || !timestamp) return false;
  const now = params.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false; // replay window
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = Buffer.from(`v0=${hmac}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
