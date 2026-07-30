"use client";

import { useEffect, useState } from "react";
import type { DraftProfile, VoiceTraitInput } from "@/lib/onboarding";
import styles from "./onboard.module.css";

const CHANNELS = ["LinkedIn", "Instagram"];

// Shown one at a time (5s each) while the demo skim runs, so the wait reads as
// "working" rather than "frozen." Short attributed lines + originals — swap
// freely; keep them short to stay clear of reproducing full copyrighted bits.
const LOADING_QUOTES: { line: string; src: string | null }[] = [
  { line: "Coffee's for closers.", src: "Glengarry Glen Ross" },
  { line: "A-B-C. Always Be Closing.", src: "Glengarry Glen Ross" },
  { line: "Would I rather be feared or loved? Both.", src: "The Office" },
  { line: "Every closer was once a cold opener.", src: null },
  { line: "Turning “um, so, basically…” into your best hook.", src: null },
  { line: "Great posts start with great calls.", src: null },
];

type Phase = "skimming" | "editing" | "saving" | "done" | "error";

export function OnboardForm({
  token,
  initialDraft,
}: {
  token: string;
  initialDraft: DraftProfile | null;
}) {
  const [draft, setDraft] = useState<DraftProfile | null>(initialDraft);
  const [phase, setPhase] = useState<Phase>(initialDraft ? "editing" : "skimming");
  const [errorMsg, setErrorMsg] = useState("");
  const [quoteIdx, setQuoteIdx] = useState(0);

  // Rotate the loading quotes while (and only while) the skim is running.
  useEffect(() => {
    if (phase !== "skimming") return;
    const id = setInterval(
      () => setQuoteIdx((i) => (i + 1) % LOADING_QUOTES.length),
      5000,
    );
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (initialDraft) return; // already have a draft; no skim needed
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/onboard/skim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error(`Couldn't read your demos (${res.status})`);
        const d = (await res.json()) as DraftProfile;
        if (!cancelled) {
          setDraft(d);
          setPhase("editing");
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg((e as Error).message);
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, initialDraft]);

  if (phase === "skimming") {
    const q = LOADING_QUOTES[quoteIdx];
    return (
      <div className={styles.loader} aria-live="polite" aria-busy="true">
        <div className={styles.loaderBar}>
          <span />
        </div>
        <p className={styles.loaderLabel}>Reading your demos and drafting your voice…</p>
        <blockquote key={quoteIdx} className={styles.quote}>
          <span className={styles.quoteLine}>“{q.line}”</span>
          {q.src ? <cite className={styles.quoteCite}>— {q.src}</cite> : null}
        </blockquote>
      </div>
    );
  }
  if (phase === "done") {
    return (
      <div className={styles.done}>
        <h2>You&apos;re all set.</h2>
        <p>The assistant will start sending you post ideas in Slack.</p>
      </div>
    );
  }
  if (phase === "error" && !draft) {
    return <p className={styles.error}>{errorMsg} — refresh to try again.</p>;
  }
  if (!draft) return null;

  const set = (patch: Partial<DraftProfile>) => setDraft({ ...draft, ...patch });

  const setTrait = (i: number, patch: Partial<VoiceTraitInput>) =>
    set({ traits: draft.traits.map((t, j) => (j === i ? { ...t, ...patch } : t)) });

  const addTrait = () =>
    set({ traits: [...draft.traits, { name: "", description: "", examples: [""] }] });

  const removeTrait = (i: number) =>
    set({ traits: draft.traits.filter((_, j) => j !== i) });

  const toggleChannel = (c: string) =>
    set({
      channels: draft.channels.includes(c)
        ? draft.channels.filter((x) => x !== c)
        : [...draft.channels, c],
    });

  const submit = async () => {
    setPhase("saving");
    setErrorMsg("");
    try {
      const res = await fetch("/api/onboard/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setPhase("done");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setPhase("editing");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label}>My name</label>
        <input
          className={styles.input}
          value={draft.displayName}
          onChange={(e) => set({ displayName: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>My voice</label>
        <span className={styles.hint}>
          How I actually sound, pulled from my demos — I&apos;ll fix anything that feels off.
        </span>
      </div>
      {draft.traits.map((t, i) => (
        <div key={i} className={styles.trait}>
          <div className={styles.traitHead}>
            <input
              className={styles.input}
              placeholder="Trait name"
              value={t.name}
              onChange={(e) => setTrait(i, { name: e.target.value })}
            />
            <button type="button" className={styles.remove} onClick={() => removeTrait(i)}>
              remove
            </button>
          </div>
          <input
            className={styles.input}
            placeholder="One-line description"
            value={t.description}
            onChange={(e) => setTrait(i, { description: e.target.value })}
          />
          <div className={styles.examples} style={{ marginTop: "0.5rem" }}>
            {t.examples.map((ex, k) => (
              <input
                key={k}
                className={styles.input}
                placeholder="Example line"
                value={ex}
                onChange={(e) =>
                  setTrait(i, {
                    examples: t.examples.map((x, j) => (j === k ? e.target.value : x)),
                  })
                }
              />
            ))}
            <button
              type="button"
              className={styles.ghost}
              onClick={() => setTrait(i, { examples: [...t.examples, ""] })}
            >
              + add example
            </button>
          </div>
        </div>
      ))}
      <div className={styles.addRow}>
        <button type="button" className={styles.ghost} onClick={addTrait}>
          + add a trait
        </button>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>My background</label>
        <span className={styles.hint}>What I did before / what I know deeply.</span>
        <textarea
          className={styles.textarea}
          value={draft.background}
          onChange={(e) => set({ background: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>My angle</label>
        <span className={styles.hint}>The distinctive POV only I bring.</span>
        <textarea
          className={styles.textarea}
          value={draft.angle}
          onChange={(e) => set({ angle: e.target.value })}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Where I post</label>
        <div className={styles.channels}>
          {CHANNELS.map((c) => (
            <label key={c} className={styles.channel}>
              <input
                type="checkbox"
                checked={draft.channels.includes(c)}
                onChange={() => toggleChannel(c)}
              />
              {c}
            </label>
          ))}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>A post I admire (optional)</label>
        <span className={styles.hint}>One whose style I&apos;d like to echo.</span>
        <textarea
          className={styles.textarea}
          value={draft.admiredPost}
          onChange={(e) => set({ admiredPost: e.target.value })}
        />
      </div>

      <button type="submit" className={styles.submit} disabled={phase === "saving"}>
        {phase === "saving" ? "Saving…" : "Save and finish"}
      </button>
      {errorMsg ? <p className={styles.error}>{errorMsg}</p> : null}
    </form>
  );
}
