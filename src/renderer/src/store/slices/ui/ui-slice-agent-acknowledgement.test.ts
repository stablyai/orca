import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import { AcceptedAgentStatuses } from '../agent-status/status-ownership/accepted-agent-statuses'
import { hydrateAgentReadState } from './ui-slice-hydration-values'
import { getDefaultUIState } from '../../../../../shared/orca-profiles/constants'

const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('acknowledging agents', () => {
  it('keeps a recent stamp that covers every known turn; stamps a first or day-old acknowledgement', () => {
    const recent = NOW - 60_000
    const dayOld = NOW - 25 * 60 * 60 * 1000
    const store = createUIStore()
    store.setState({
      agentStatusByPaneKey: new AcceptedAgentStatuses(),
      migrationUnsupportedByPtyId: {},
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': recent, 'tab-3:leaf-1': dayOld }
    })

    store.getState().acknowledgeAgents(['tab-1:leaf-1', 'tab-2:leaf-1', 'tab-3:leaf-1'])

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
      'tab-1:leaf-1': recent,
      'tab-2:leaf-1': NOW,
      'tab-3:leaf-1': NOW
    })
  })
})

describe('hydrating read state', () => {
  it('keeps a week-old read mark, since a placed agent row outlives the hook TTL', () => {
    const weekOld = NOW - 8 * 24 * 60 * 60 * 1000
    expect(
      hydrateAgentReadState({
        ...getDefaultUIState(),
        acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': weekOld }
      }).acknowledgedAgentsByPaneKey
    ).toEqual({ 'tab-1:leaf-1': weekOld })
  })
})
