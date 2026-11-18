import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createUIStore } from './ui-slice-test-harness'

describe('acknowledging agents', () => {
  it('keeps a recent stamp that covers every known turn; stamps a first or day-old acknowledgement', () => {
    const now = Date.now()
    const recent = now - 60_000
    const dayOld = now - 25 * 60 * 60 * 1000
    const store = createUIStore()
    store.setState({
      agentStatusByPaneKey: new Map(),
      migrationUnsupportedByPtyId: {},
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': recent, 'tab-3:leaf-1': dayOld }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents(['tab-1:leaf-1', 'tab-2:leaf-1', 'tab-3:leaf-1'])

    const acknowledged = store.getState().acknowledgedAgentsByPaneKey
    expect(acknowledged['tab-1:leaf-1']).toBe(recent)
    expect(acknowledged['tab-2:leaf-1']).toBeGreaterThanOrEqual(now)
    expect(acknowledged['tab-3:leaf-1']).toBeGreaterThanOrEqual(now)
  })
})
