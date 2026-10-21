/**
 * The order shown while the pointer is over the list or a drag runs: rows keep their places, rows
 * that left go, and new rows enter where the new order puts them. Same set, same array.
 */
export function mergeHeldOrder(held: string[], next: readonly string[]): string[] {
  const nextIds = new Set(next)
  const heldIds = new Set(held)
  const kept = held.filter((id) => nextIds.has(id))
  if (kept.length === held.length && kept.length === next.length) {
    return held
  }
  next.forEach((id, index) => {
    if (!heldIds.has(id)) {
      kept.splice(index === 0 ? 0 : kept.indexOf(next[index - 1]) + 1, 0, id)
    }
  })
  return kept
}
