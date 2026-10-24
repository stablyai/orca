/** What the renderer learns from asking the desktop for an extra window. */
export type RuntimeClientWindowOpenResult = { ok: true } | { ok: false; reason: string }
