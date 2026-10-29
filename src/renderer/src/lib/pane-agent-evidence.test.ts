import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { resolvePaneAgentActivity } from './pane-agent-evidence'

const NOW = 1_700_000_000_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:leaf-1',
    agentType: 'claude',
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    ...overrides
  } as AgentStatusEntry
}

describe('resolvePaneAgentActivity', () => {
  it('reports a fresh hook row as the authoritative source and keeps the title layer visible', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'waiting' }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision).toEqual({
      hookState: 'waiting',
      hookAgentType: 'claude',
      titleStatus: 'working',
      source: 'hook',
      confidence: 'authoritative',
      livePtyRequired: false
    })
  })

  it('treats a stale hook row as absent and falls back to the title', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision.hookState).toBe(null)
    expect(decision.source).toBe('title')
    expect(decision.confidence).toBe('fallback')
    expect(decision.titleStatus).toBe('working')
    expect(decision.livePtyRequired).toBe(false)
  })

  it('flags title-only evidence without a live PTY so liveness-gated consumers drop it', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: '⠋ running the tests',
      hasLivePty: false,
      now: NOW
    })
    expect(decision.source).toBe('title')
    expect(decision.livePtyRequired).toBe(true)
  })

  it('reports none when there is no fresh hook and the title carries no status', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: 'bash',
      hasLivePty: true,
      now: NOW
    })
    expect(decision).toEqual({
      hookState: null,
      hookAgentType: undefined,
      titleStatus: null,
      source: 'none',
      confidence: 'authoritative',
      livePtyRequired: false
    })
  })
})
