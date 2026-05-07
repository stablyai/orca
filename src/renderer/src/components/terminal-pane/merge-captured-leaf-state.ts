// Why: setTabLayout REPLACES the stored layout — it doesn't merge. captureBuffers
// can run during a transient window (post-remount, just-attached, mid-replay)
// where xterm hasn't rendered yet so serialize returns 0 bytes for every pane.
// Without preserving prior entries, that empty pass wipes a known-good buffer
// from the persisted state and the user loses their scrollback on next launch.
// This helper merges prior state with this pass's fresh state so a no-op
// capture never erases a known-good buffer.

export type LeafStringMap = Record<string, string>

export function mergeCapturedLeafState(opts: {
  prior: LeafStringMap | undefined
  fresh: LeafStringMap
  currentLeafIds: ReadonlySet<string>
}): LeafStringMap {
  const merged: LeafStringMap = {}
  if (opts.prior) {
    for (const [leafId, value] of Object.entries(opts.prior)) {
      if (opts.currentLeafIds.has(leafId)) {
        merged[leafId] = value
      }
    }
  }
  for (const [leafId, value] of Object.entries(opts.fresh)) {
    if (opts.currentLeafIds.has(leafId)) {
      merged[leafId] = value
    }
  }
  return merged
}
