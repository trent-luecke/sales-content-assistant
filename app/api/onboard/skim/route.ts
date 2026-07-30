import { getProfileByToken } from "@/lib/profiles";
import { readRepDemos, deriveVoiceProfile } from "@/lib/mining";
import { draftFromVoice } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // reads demos + runs the voice model

export async function POST(req: Request) {
  let token: unknown;
  try {
    token = (await req.json())?.token;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "missing token" }, { status: 400 });
  }

  // Resolve the rep fresh from the token — never trust a client-supplied id.
  const profile = await getProfileByToken(token);
  if (!profile) return new Response("not found", { status: 404 });

  const demos = await readRepDemos(profile.avoma_rep_name, 6);
  if (demos.length === 0) {
    // No demos indexed yet — return an empty draft the rep can fill by hand.
    return Response.json(draftFromVoice(profile, { traits: [], background: "", angle: "" }));
  }

  const voice = await deriveVoiceProfile(demos);
  return Response.json(draftFromVoice(profile, voice));
}
