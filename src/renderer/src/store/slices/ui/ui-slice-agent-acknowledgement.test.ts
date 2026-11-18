import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import { createUIStore } from './ui-slice-test-harness'

describe('acknowledging agents', () => {
  it('keeps a stamp that already covers every known turn, and still advances an uncovered one', () => {
    const store = createUIStore()
    store.setState({
      agentStatusByPaneKey: new Map(),
      migrationUnsupportedByPtyId: {},
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': 1_000 }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents(['tab-1:leaf-1', 'tab-2:leaf-1'])

    const acknowledged = store.getState().acknowledgedAgentsByPaneKey
    expect(acknowledged['tab-1:leaf-1']).toBe(1_000)
    expect(acknowledged['tab-2:leaf-1']).toBeGreaterThan(1_000)
  })
})
