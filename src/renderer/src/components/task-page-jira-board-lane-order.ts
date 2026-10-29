// Device-local, like the Jira view mode: lane order is a reading preference, never written to Jira.
const STORAGE_KEY = 'orca.jira.board-lane-order.v1'

// Keyed by name so one order covers board columns and the status-name fallback lanes.
export function jiraBoardLaneName(label: string): string {
  return label.trim().toLowerCase()
}

export function loadJiraBoardLaneOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((name): name is string => typeof name === 'string')
      : []
  } catch {
    return []
  }
}

export function saveJiraBoardLaneOrder(order: readonly string[]): void {
  try {
    if (order.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The live board stays usable when browser storage is unavailable or full.
  }
}

// Saved lanes trade places among themselves; unsaved lanes keep their default slots.
export function applyJiraBoardLaneOrder<T extends { label: string }>(
  lanes: readonly T[],
  order: readonly string[]
): T[] {
  const rank = new Map(order.map((name, index) => [name, index]))
  const rankOf = (lane: T): number | undefined => rank.get(jiraBoardLaneName(lane.label))
  const ranked = lanes
    .filter((lane) => rankOf(lane) !== undefined)
    .sort((a, b) => (rankOf(a) ?? 0) - (rankOf(b) ?? 0))
  let next = 0
  return lanes.map((lane) => (rankOf(lane) === undefined ? lane : ranked[next++]))
}

export function moveJiraBoardLane(
  visibleLabels: readonly string[],
  fromIndex: number,
  toIndex: number,
  previousOrder: readonly string[]
): string[] {
  const visible = visibleLabels.map(jiraBoardLaneName)
  const [moved] = visible.splice(fromIndex, 1)
  if (moved === undefined) {
    return [...previousOrder]
  }
  visible.splice(Math.max(0, Math.min(toIndex, visible.length)), 0, moved)
  const order = [...new Set(visible)]
  // Status-name lanes come and go with their issues; keep hidden ones next to their old neighbour.
  previousOrder.forEach((name, index) => {
    if (order.includes(name)) {
      return
    }
    const anchor = previousOrder.slice(0, index).findLast((before) => order.includes(before))
    order.splice(anchor === undefined ? 0 : order.indexOf(anchor) + 1, 0, name)
  })
  return order
}
