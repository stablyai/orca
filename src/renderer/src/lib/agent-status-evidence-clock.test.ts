import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { isExplicitAgentStatusFresh } from './pane-agent-evidence'

const NOW = new Date('2026-04-09T12:00:00.000Z').getTime()
const OBSERVED_AT = NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000

function workingRow(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'working',
    prompt: 'do the thing',
    // A reconnect replay restamps the delivery clock; that must not read as new evidence.
    updatedAt: NOW,
    stateStartedAt: OBSERVED_AT,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

describe('staleness measures when evidence was observed, not when it was delivered', () => {
  it('decays a replayed row whose evidence is older than the window', () => {
    const row = workingRow({ evidenceObservedAt: OBSERVED_AT })
    expect(isFreshNonDoneAgentStatus(row, NOW)).toBe(false)
    expect(isExplicitAgentStatusFresh(row, NOW, AGENT_STATUS_STALE_AFTER_MS)).toBe(false)
  })

  it('falls back to the delivery clock for a row from a host that sends no observation time', () => {
    const row = workingRow()
    expect(isFreshNonDoneAgentStatus(row, NOW)).toBe(true)
    expect(isExplicitAgentStatusFresh(row, NOW, AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
  })

  it('keeps a live row fresh when its evidence was just observed', () => {
    const row = workingRow({ evidenceObservedAt: NOW })
    expect(isFreshNonDoneAgentStatus(row, NOW)).toBe(true)
    expect(isExplicitAgentStatusFresh(row, NOW, AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
  })
})
