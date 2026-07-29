import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifySlackSignature } from "@/lib/slack/verify";

const secret = "test_signing_secret";
function sign(body: string, ts: string) {
  const h = crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return `v0=${h}`;
}

describe("verifySlackSignature", () => {
  const now = 1_700_000_000;
  const body = '{"type":"event_callback"}';
  const ts = String(now);

  it("accepts a valid signature within the time window", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body, now,
    })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body + "x", now,
    })).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: sign(body, ts), timestamp: ts, rawBody: body, now: now + 600,
    })).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(verifySlackSignature({
      signingSecret: secret, signature: null, timestamp: null, rawBody: body, now,
    })).toBe(false);
  });
});
