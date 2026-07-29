// Returns the first forbidden name appearing in `text` (case-insensitive, on
// word boundaries), or null if none. Used to catch customer/prospect/deal
// names leaking into rep-facing copy.
export function containsAny(text: string, names: string[]): string | null {
  const haystack = text.toLowerCase();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
    if (re.test(haystack)) return raw;
  }
  return null;
}
