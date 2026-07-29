import { describe, it, expect } from "vitest";
import { healthPayload } from "@/lib/health";

describe("healthPayload", () => {
  it("reports ok with a service name", () => {
    expect(healthPayload()).toEqual({ ok: true, service: "sca-phase0" });
  });
});
