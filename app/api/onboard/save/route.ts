import { getProfileByToken, saveProfile } from "@/lib/profiles";
import { parseSavePayload, savePayloadToPatch } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const parsed = parseSavePayload(raw);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // Resolve the rep fresh from the token — the client never sends a rep_id.
  const profile = await getProfileByToken(parsed.value.token);
  if (!profile) return new Response("not found", { status: 404 });

  await saveProfile(profile.id, savePayloadToPatch(parsed.value), true);
  return Response.json({ ok: true });
}
