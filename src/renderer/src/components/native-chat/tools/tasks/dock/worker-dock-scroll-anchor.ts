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

/** Where the open card's list rests: its first visible row and how far into that row it is. */
export function workerDockScrollAnchorAt(
  element: HTMLElement,
  drawn: readonly { index: number; start: number; end: number }[] | null,
  rows: readonly { id: string }[]
): WorkerDockScrollAnchor | null {
  const first = (
    drawn ??
    [...element.querySelectorAll<HTMLElement>('[data-index]')].map((node) => ({
      index: Number(node.dataset.index),
      start: node.offsetTop,
      end: node.offsetTop + node.offsetHeight
    }))
  ).find((item) => item.end > element.scrollTop)
  return first && rows[first.index]
    ? {
        id: rows[first.index].id,
        offset: element.scrollTop - first.start,
        index: first.index,
        order: rows
      }
    : null
}

/** The row Up, Down, Home or End moves focus to; past the last row is `length` (the pill below). */
export function workerDockRowKeyTarget(key: string, index: number, length: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return index + 1
    case 'ArrowUp':
      return Math.max(0, index - 1)
    case 'Home':
      return 0
    case 'End':
      return length - 1
    default:
      return null
  }
}

/** A soft edge where the card's list has more rows out of view: at the bottom while rows remain
 *  below, at the top once it has scrolled. Undefined when everything fits. */
export function workerDockScrollFade(element: HTMLElement): string | undefined {
  const top = element.scrollTop > 1
  const bottom = element.scrollTop + element.clientHeight < element.scrollHeight - 1
  if (!top && !bottom) {
    return undefined
  }
  const start = top ? 'transparent, black 16px' : 'black'
  const end = bottom ? 'black calc(100% - 16px), transparent' : 'black'
  return `linear-gradient(to bottom, ${start}, ${end})`
}
