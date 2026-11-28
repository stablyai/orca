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

/** Where a key pressed on a list row moves focus: another row's index, the chip above the first
 *  row, or null when the key is not a list move. */
export function workerDockListKeyTarget(
  event: { key: string; target: EventTarget | null },
  ids: readonly string[]
): number | 'chip' | null {
  const row =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-worker-dock-row]')
      : null
  const index = ids.indexOf(row?.dataset.workerDockRow ?? '')
  const next = index === -1 ? null : workerDockRowKeyTarget(event.key, index, ids.length)
  if (next === null) {
    return null
  }
  // The open chip heads the list: up from the first row returns to it.
  return event.key === 'ArrowUp' && index === 0 ? 'chip' : Math.min(next, ids.length - 1)
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
