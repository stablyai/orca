import { onDesktopSidebarFeedInstalled } from './desktop-sidebar-feed'

// Bounds an id main never lists, such as a create cancelled before main opened it.
const ENDED_LIMIT_MS = 10_000

let ended: ReadonlySet<string> = new Set()
let detachSettlement: (() => void) | null = null
const listeners = new Set<() => void>()

function publish(next: ReadonlySet<string>): void {
  ended = next
  listeners.forEach((listener) => listener())
}

function keep(listed: (creationId: string) => boolean): void {
  const next = new Set([...ended].filter(listed))
  if (next.size !== ended.size) {
    publish(next)
  }
}

/** The window ended its own creation; main's feed can list it a read longer, with nothing to draw. */
export function endWindowCreation(creationId: string): void {
  detachSettlement ??= onDesktopSidebarFeedInstalled(({ domains }) =>
    keep((id) => domains.creations.has(id))
  )
  publish(new Set(ended).add(creationId))
  setTimeout(() => keep((id) => id !== creationId), ENDED_LIMIT_MS)
}

export function subscribeEndedCreations(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readEndedCreations(): ReadonlySet<string> {
  return ended
}
