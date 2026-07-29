export function healthPayload() {
  return { ok: true, service: "sca-phase0" } as const;
}
