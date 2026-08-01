import type { RemoteTerminalTarget } from '../peer-collab/remote-terminal-target'

/** Max RemoteTerminalPanel instances kept mounted (and streaming) at once, including the visible pane(s). */
export const PEERS_KEEP_ALIVE_MAX = 4

function targetKey(target: RemoteTerminalTarget): string {
  return `${target.hostId}:${target.handle}`
}

export function isSameTarget(
  a: RemoteTerminalTarget | null | undefined,
  b: RemoteTerminalTarget | null | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return targetKey(a) === targetKey(b)
}

/**
 * Moves `target` to the front of `mounted` (adding it if new). When the list
 * exceeds `max`, evicts the least-recently-visited entries that aren't in
 * `pinned` — the pane(s) that must always stay mounted (primary/split).
 */
export function visitPeersKeepAlive(
  mounted: readonly RemoteTerminalTarget[],
  target: RemoteTerminalTarget,
  pinned: readonly RemoteTerminalTarget[],
  max: number = PEERS_KEEP_ALIVE_MAX
): RemoteTerminalTarget[] {
  const key = targetKey(target)
  const next = [target, ...mounted.filter((t) => targetKey(t) !== key)]
  if (next.length <= max) {
    return next
  }
  const pinnedKeys = new Set(pinned.map(targetKey))
  const overflow = next.length - max
  // Why: next is MRU-first, so the tail (highest index) is the oldest.
  const oldestFirstEvictable = next
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => !pinnedKeys.has(targetKey(t)))
    .sort((a, b) => b.index - a.index)
  const toEvict = new Set(oldestFirstEvictable.slice(0, overflow).map(({ t }) => targetKey(t)))
  return next.filter((t) => !toEvict.has(targetKey(t)))
}

/** Drops any mounted target the host no longer grants (host disconnected or terminal revoked). */
export function pruneUngrantedKeepAlive(
  mounted: readonly RemoteTerminalTarget[],
  isGranted: (target: RemoteTerminalTarget) => boolean
): RemoteTerminalTarget[] {
  return mounted.filter(isGranted)
}
