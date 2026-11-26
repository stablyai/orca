// A list maps to the list it was copied from with entries replaced at these positions, nothing moved.
// Held weakly, so a stream's revisions don't keep each earlier list alive through the next.
const revisions = new WeakMap<
  readonly object[],
  { from: WeakRef<readonly object[]>; at: readonly number[] }
>()

/** Records that `next` is `from` with only the entries at `at` replaced, so each later stage can
 *  revise its own last output at those rows instead of walking the whole list again. */
export function noteRevisedInPlace<T extends object>(
  next: readonly T[],
  from: readonly T[],
  at: readonly number[]
): void {
  if (next !== from && next.length === from.length) {
    revisions.set(next, { from: new WeakRef(from), at })
  }
}

/** The list `next` was revised from, with the positions it replaced, while that list is alive. */
export function revisedInPlace<T extends object>(
  next: readonly T[]
): { from: readonly T[]; at: readonly number[] } | undefined {
  const revision = revisions.get(next)
  const from = revision?.from.deref()
  if (!revision || !from) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only lists of one row type are linked.
  return { from: from as readonly T[], at: revision.at }
}

/** Positions `next` replaced in `from`, when it is a revision of exactly that list. */
export function positionsRevisedFrom<T extends object>(
  next: readonly T[],
  from: readonly T[]
): readonly number[] | undefined {
  const revision = revisions.get(next)
  return revision && revision.from.deref() === from ? revision.at : undefined
}
