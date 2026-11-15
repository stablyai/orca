export type WorkerDockScrollAnchor = {
  id: string
  offset: number
  index: number
  order: readonly { id: string }[]
}

export function workerDockAnchorIndex(
  anchor: WorkerDockScrollAnchor,
  rows: readonly { id: string }[]
): number {
  const positions = new Map(rows.map((row, index) => [row.id, index]))
  const current = positions.get(anchor.id)
  if (current !== undefined) {
    return current
  }
  for (let index = anchor.index + 1; index < anchor.order.length; index++) {
    const next = positions.get(anchor.order[index].id)
    if (next !== undefined) {
      return next
    }
  }
  for (let index = anchor.index - 1; index >= 0; index--) {
    const previous = positions.get(anchor.order[index].id)
    if (previous !== undefined) {
      return previous
    }
  }
  return Math.min(anchor.index, rows.length - 1)
}
