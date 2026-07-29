import crypto from "node:crypto";
import { scaClient } from "@/lib/supabase";

export interface Profile {
  id: string;
  avoma_rep_name: string;
  slack_user_id: string;
  magic_token: string;
  display_name: string | null;
  voice_traits: unknown[];
  background: string | null;
  angle: string | null;
  channels: unknown[];
  admired_post: string | null;
  status: "draft" | "active";
}

export function newMagicToken(): string {
  return crypto.randomBytes(24).toString("base64url"); // 32 url-safe chars
}

export async function createDraftProfile(input: {
  avomaRepName: string; slackUserId: string; displayName?: string;
}): Promise<Profile> {
  const { data, error } = await scaClient().from("sca_profiles").insert({
    avoma_rep_name: input.avomaRepName,
    slack_user_id: input.slackUserId,
    display_name: input.displayName ?? null,
    magic_token: newMagicToken(),
    status: "draft",
  }).select("*").single();
  if (error) throw error;
  return data as Profile;
}

export async function getProfileByToken(token: string): Promise<Profile | null> {
  const { data, error } = await scaClient()
    .from("sca_profiles").select("*").eq("magic_token", token).maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function getProfileBySlackUser(slackUserId: string): Promise<Profile | null> {
  const { data, error } = await scaClient()
    .from("sca_profiles").select("*").eq("slack_user_id", slackUserId).maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function saveProfile(
  id: string, patch: Partial<Profile>, activate: boolean,
): Promise<void> {
  const { error } = await scaClient().from("sca_profiles").update({
    ...patch,
    ...(activate ? { status: "active" } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (error) throw error;
}
