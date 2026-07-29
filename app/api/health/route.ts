import { healthPayload } from "@/lib/health";

export async function GET() {
  return Response.json(healthPayload());
}
