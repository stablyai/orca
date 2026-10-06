/**
 * What one computer in the pane is doing, as far as this client can tell.
 *
 * `checking` is not `offline`: a probe still in flight is no evidence the host
 * is unreachable, so it is neither counted as offline nor skipped as one.
 */
export type SessionSearchComputerState = 'on' | 'off' | 'checking' | 'needs-update' | 'offline'

export type SessionSearchComputerEntry = {
  id: string
  name: string
  state: SessionSearchComputerState
}

export function isTurnOnableSessionSearchState(state: SessionSearchComputerState): boolean {
  return state === 'off'
}

// Reachable and working first, then what the user could act on, then what they cannot.
const STATE_RANK: Record<SessionSearchComputerState, number> = {
  on: 0,
  off: 1,
  checking: 1,
  'needs-update': 2,
  offline: 3
}

/** Stable order for the server list: by state group, then by name within a group. */
export function orderSessionSearchServers<T extends SessionSearchComputerEntry>(
  entries: readonly T[]
): T[] {
  return [...entries].sort((left, right) => {
    const byState = STATE_RANK[left.state] - STATE_RANK[right.state]
    return byState === 0 ? left.name.localeCompare(right.name) : byState
  })
}
