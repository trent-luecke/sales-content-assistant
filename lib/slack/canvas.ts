import { slack } from "@/lib/slack/client";

// Create a Canvas attached to the rep's DM (renders inline). Spike B verified
// conversations.canvases.create is the path that opens for the user; the
// standalone canvases.create + link path does NOT. Returns the canvas id.
export async function createCanvasInDM(
  channel: string,
  title: string,
  markdown: string,
): Promise<string> {
  const res = await slack.conversations.canvases.create({
    channel_id: channel,
    title,
    document_content: { type: "markdown", markdown },
  });
  const id = res.canvas_id;
  if (!id) throw new Error("conversations.canvases.create returned no canvas_id");
  return id;
}

// Replace the whole Canvas document in place (Spike B: full-document replace
// updates the same canvas, no new one spawned). Used by the iteration loop (step 7).
export async function editCanvas(canvasId: string, markdown: string): Promise<void> {
  await slack.canvases.edit({
    canvas_id: canvasId,
    changes: [{ operation: "replace", document_content: { type: "markdown", markdown } }],
  });
}

// Delete a bot-owned Canvas (used by the cleanup "Done" flow). Throws on API error so the
// caller can keep the sca_thread_map row and the opener message honest about what happened.
//
// EXPERIMENT (2026-08-07): canvases.delete removes the draft content but leaves a
// "deleted by owner" tombstone in the DM that no API seems to remove — and those stubs
// accumulate at the top of the DM. Try files.delete on the canvas's backing file first (a
// canvas IS a file) to see whether it removes the canvas without the tombstone; log the
// outcome so `vercel logs` shows what happened. Fall back to canvases.delete so the draft is
// deleted regardless of the experiment's result (no regression).
export async function deleteCanvas(canvasId: string): Promise<void> {
  try {
    const res = await slack.files.delete({ file: canvasId });
    console.log("EXPERIMENT files.delete", { canvasId, ok: res.ok });
    return;
  } catch (e) {
    console.error("EXPERIMENT files.delete failed → falling back to canvases.delete", { canvasId, error: e });
    await slack.canvases.delete({ canvas_id: canvasId });
  }
}
