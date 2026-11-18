// setTabLayout replaces stored buffers; preserve known-good output when a transient remount/replay serializes empty panes.

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
