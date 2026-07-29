import { describe, it, expect } from "vitest";
import { containsAny } from "@/lib/guardrail";

describe("containsAny", () => {
  it("finds a forbidden name regardless of case", () => {
    expect(containsAny("Great call with Acme Corp today", ["Acme Corp"])).toBe("Acme Corp");
    expect(containsAny("chatting with gretchen", ["Gretchen"])).toBe("Gretchen");
  });
  it("returns null when no name is present", () => {
    expect(containsAny("a strength coach I spoke with", ["Acme Corp", "Gretchen"])).toBeNull();
  });
  it("does not match a name embedded inside another word", () => {
    expect(containsAny("the according plan", ["Acme"])).toBeNull(); // 'Acme' not in 'according'
  });
  it("ignores empty names", () => {
    expect(containsAny("anything", ["", "  "])).toBeNull();
  });
});
