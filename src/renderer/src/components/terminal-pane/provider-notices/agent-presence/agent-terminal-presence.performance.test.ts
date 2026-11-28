import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Perf contract for #51262: the arrival watch must not walk every pane on each agent status write.
type FakeState = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]>
  agentStatusByPaneKey: { entries: () => IterableIterator<[string, { agentType: string }]> }
  paneForegroundAgentByPaneKey: Record<string, { agent: string }>
}

const store = vi.hoisted(() => {
  let state: FakeState | null = null
  const listeners = new Set<(next: FakeState, previous: FakeState) => void>()
  return {
    scans: 0,
    getState: () => state!,
    setState(next: FakeState) {
      const previous = state!
      state = next
      for (const listener of listeners) {
        listener(next, previous)
      }
    },
    reset(next: FakeState) {
      state = next
      listeners.clear()
    },
    subscribe(listener: (next: FakeState, previous: FakeState) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})

vi.mock('@/store/index', () => ({
  useAppStore: { getState: store.getState, subscribe: store.subscribe }
}))

const { watchAgentTerminalArrivals } = await import('./agent-terminal-presence')

function statusMap(panes: number): FakeState['agentStatusByPaneKey'] {
  const rows = new Map(
    Array.from({ length: panes }, (_, i) => [`tab-${i}:1`, { agentType: 'claude' }] as const)
  )
  return {
    entries: () => {
      store.scans++
      return rows.entries()
    }
  }
}

function stateWith(panes: number): FakeState {
  return {
    tabsByWorktree: {
      wt: Array.from({ length: panes }, (_, i) => ({ id: `tab-${i}` }))
    },
    agentStatusByPaneKey: statusMap(panes),
    paneForegroundAgentByPaneKey: {}
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  store.scans = 0
})
afterEach(() => vi.useRealTimers())

describe('watchAgentTerminalArrivals', () => {
  it.each([50, 500])('scans once per window, not per status write, with %i panes', (panes) => {
    const initial = stateWith(panes)
    store.reset(initial)
    const stop = watchAgentTerminalArrivals(() => {})
    for (let write = 0; write < 1000; write++) {
      store.setState({ ...store.getState(), agentStatusByPaneKey: statusMap(panes) })
    }
    vi.advanceTimersByTime(1000)
    stop()
    // One scan at start plus one for the whole burst.
    expect(store.scans).toBe(2)
  })
})
