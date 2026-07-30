import { getProfileBySlackUser, createDraftProfile } from "@/lib/profiles";

export const dynamic = "force-dynamic";

const OWNER_SLACK = "U04ECG6KEA3";
const OWNER_AVOMA = "Trent Luecke";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== "onboardlink") {
    return new Response("forbidden", { status: 403 });
  }
  const slack = url.searchParams.get("slack") ?? OWNER_SLACK;
  const avoma = url.searchParams.get("avoma") ?? OWNER_AVOMA;

  let p = await getProfileBySlackUser(slack);
  if (!p) {
    p = await createDraftProfile({
      avomaRepName: avoma,
      slackUserId: slack,
      displayName: avoma.split(/\s+/)[0],
    });
  }
  return Response.json({
    onboardUrl: `${url.origin}/onboard/${p.magic_token}`,
    status: p.status,
  });
}
