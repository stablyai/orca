/** Checking probes are not evidence of offline hosts; neither count nor skip them as offline. */
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

export function orderSessionSearchServers<T extends SessionSearchComputerEntry>(
  entries: readonly T[]
): T[] {
  return [...entries].sort((left, right) => {
    const byState = STATE_RANK[left.state] - STATE_RANK[right.state]
    return byState === 0 ? left.name.localeCompare(right.name) : byState
  })
}
