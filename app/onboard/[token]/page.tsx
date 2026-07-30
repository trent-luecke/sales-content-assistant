import { notFound } from "next/navigation";
import { getProfileByToken } from "@/lib/profiles";
import { hasBeenSkimmed, draftFromProfile } from "@/lib/onboarding";
import { OnboardForm } from "./OnboardForm";
import styles from "./onboard.module.css";

export const dynamic = "force-dynamic";

export default async function OnboardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const profile = await getProfileByToken(token);
  if (!profile) notFound();

  // If a skim (or prior save) already populated the profile, pre-fill from
  // stored data and skip the expensive re-skim; otherwise let the form skim.
  const initialDraft = hasBeenSkimmed(profile) ? draftFromProfile(profile) : null;

  return (
    <main className={styles.wrap}>
      <h1 className={styles.h1}>Let&apos;s tune your voice</h1>
      <p className={styles.sub}>
        We read a few of your demos and took a first guess. Tighten anything that
        doesn&apos;t sound like you, add a couple of specifics, and you&apos;re set.
      </p>
      <OnboardForm token={token} initialDraft={initialDraft} />
    </main>
  );
}
