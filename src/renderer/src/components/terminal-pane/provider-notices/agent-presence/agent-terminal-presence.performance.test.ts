import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Perf contract for #51262: the arrival watch must not walk every pane on each agent status write.
type FakeState = {
  tabsByWorktree: Record<string, { id: string; launchAgent?: string }[]>
  agentStatusByPaneKey: {
    size: number
    entries: () => IterableIterator<[string, { agentType: string }]>
  }
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
    size: rows.size,
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

/** Per-hook status updates: rows rewritten in place, so the pane count never changes. */
function statusBurst(panes: number): void {
  for (let write = 0; write < 1000; write++) {
    store.setState({ ...store.getState(), agentStatusByPaneKey: statusMap(panes) })
  }
  vi.advanceTimersByTime(1000)
}

describe('watchAgentTerminalArrivals', () => {
  it.each([50, 500])(
    'reads status rows once at start, never for in-place status updates, with %i panes',
    (panes) => {
      store.reset(stateWith(panes))
      // Codex is wanted but never runs: the case that used to rescan every window.
      const stop = watchAgentTerminalArrivals(
        () => {},
        () => new Set(['codex'])
      )
      statusBurst(panes)
      statusBurst(panes)
      statusBurst(panes)
      stop()
      expect(store.scans).toBe(1)
    }
  )

  it('reads status rows again only when a pane gains a row', () => {
    store.reset(stateWith(500))
    const stop = watchAgentTerminalArrivals(
      () => {},
      () => new Set(['codex'])
    )
    store.setState({ ...store.getState(), agentStatusByPaneKey: statusMap(501) })
    vi.advanceTimersByTime(1000)
    statusBurst(501)
    stop()
    expect(store.scans).toBe(2)
  })

  it('does no wanted-agent work for writes that touch no arrival source', () => {
    store.reset(stateWith(500))
    let wantedCalls = 0
    const stop = watchAgentTerminalArrivals(
      () => {},
      () => {
        wantedCalls++
        return new Set(['codex'])
      }
    )
    const afterStart = wantedCalls
    for (let write = 0; write < 1000; write++) {
      store.setState({ ...store.getState() })
    }
    stop()
    expect(wantedCalls).toBe(afterStart)
  })

  it('arms no timer once every wanted agent has been seen', () => {
    store.reset(stateWith(500))
    const seen: string[] = []
    const stop = watchAgentTerminalArrivals(
      (agent) => seen.push(agent),
      () => new Set(['claude'])
    )
    store.setState({ ...store.getState(), agentStatusByPaneKey: statusMap(501) })
    expect(vi.getTimerCount()).toBe(0)
    stop()
    expect(seen).toEqual(['claude'])
    expect(store.scans).toBe(1)
  })
})
