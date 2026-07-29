import { describe, it, expect } from "vitest";
import { newMagicToken } from "@/lib/profiles";

describe("newMagicToken", () => {
  it("is URL-safe and long enough to be unguessable", () => {
    const t = newMagicToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
  it("is different every call", () => {
    expect(newMagicToken()).not.toBe(newMagicToken());
  });
});
