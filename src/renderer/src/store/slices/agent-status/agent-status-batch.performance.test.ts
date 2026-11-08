import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusBatchUpdate } from './agent-status-contract'
import { buildAgentStatusScaleFixture } from './agent-status-scale.test-fixture'

// One burst has one externally visible snapshot, irrespective of how many panes it changes.
describe('agent status burst publication contract', () => {
  afterEach(() => vi.useRealTimers())

  it.each([8, 80])('publishes %i updates once and retains untouched entries', (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000_000)
    const { store, paneKeys, owners, agentStatusByPaneKey } = buildAgentStatusScaleFixture()
    store.setState({ agentStatusByPaneKey })
    const before = store.getState().agentStatusByPaneKey
    const published = vi.fn()
    const stop = store.subscribe(published)
    const updates: AgentStatusBatchUpdate[] = paneKeys.slice(0, count).map((paneKey, index) => ({
      paneKey,
      payload: { state: 'working', agentType: 'claude', prompt: 'new prompt' },
      timing: { updatedAt: 2_000_000_001 },
      routing: owners[index]
    }))
    store.getState().setAgentStatuses(updates)
    stop()
    expect(published).toHaveBeenCalledTimes(1)
    const after = store.getState().agentStatusByPaneKey
    for (const paneKey of paneKeys.slice(0, count)) {
      expect(after[paneKey].prompt).toBe('new prompt')
    }
    for (const paneKey of paneKeys.slice(count)) {
      expect(after[paneKey]).toBe(before[paneKey])
    }
  })
})
