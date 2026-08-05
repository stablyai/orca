// Why: the tree is opt-in, so only an explicit saved setting opens it — an absent
// setting (still loading, or never touched) must not flash the tree open.
export function isCombinedDiffFileTreeCollapsedByDefault(
  combinedDiffFileTreeVisibleByDefault: boolean | undefined
): boolean {
  return combinedDiffFileTreeVisibleByDefault !== true
}
