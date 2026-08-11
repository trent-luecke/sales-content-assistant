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
// NOTE (2026-08-07): both canvases.delete and files.delete leave a "deleted by owner" stub
// pinned at the top of the DM that no API removes — see the single-canvas redesign spec.
export async function deleteCanvas(canvasId: string): Promise<void> {
  await slack.canvases.delete({ canvas_id: canvasId });
}
