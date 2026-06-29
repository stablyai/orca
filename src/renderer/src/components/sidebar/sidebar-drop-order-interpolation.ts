/** Pick a finite order value between two neighbor ranks for sparse,
 *  midpoint-based sidebar ordering. Shared by project-group order and
 *  group tab order so the drag math stays identical. */
export function interpolateSparseOrder(
  before: number | undefined,
  after: number | undefined
): number {
  if (before === undefined && after === undefined) {
    return 0
  }
  if (before === undefined) {
    return (after as number) - 1
  }
  if (after === undefined) {
    return before + 1
  }
  if (after > before) {
    return before + (after - before) / 2
  }
  // Why: duplicate legacy ranks leave no numeric slot between neighbors; choose
  // a deterministic finite value so the next drag has a persisted anchor.
  return before + 1
}
