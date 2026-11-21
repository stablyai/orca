import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdPaneForNewerDaemon, newerDaemonHoldStore } from './newer-daemon-hold-state'

// Every hold write re-renders each shown banner's count, so a restore burst of N holds must not cost N writes.

const N = 200

afterEach(() => {
  vi.useRealTimers()
  newerDaemonHoldStore.setState({ panes: {} })
})

describe('a restore burst that holds many panes for a newer daemon', () => {
  it('registers every held pane in one store write', () => {
    vi.useFakeTimers()
    let writes = 0
    const unsubscribe = newerDaemonHoldStore.subscribe(() => {
      writes += 1
    })
    const release = async () => ({ reopened: true, agentResumed: false })
    for (let i = 0; i < N; i++) {
      holdPaneForNewerDaemon(`tab-${i}:leaf`, { resumable: false, release })
    }
    vi.runAllTimers()
    unsubscribe()
    expect(writes).toBe(1)
    expect(Object.keys(newerDaemonHoldStore.getState().panes)).toHaveLength(N)
  })
})
