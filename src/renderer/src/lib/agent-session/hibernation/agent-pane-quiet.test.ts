import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { isAgentPaneQuiet } from './agent-pane-quiet'

const OLD = 1_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

const quiet = { inputAt: null, inUse: false, shownRemotely: false }

describe('isAgentPaneQuiet', () => {
  it('treats a cleanly finished pane as quiet', () => {
    expect(isAgentPaneQuiet(entry(), quiet)).toBe(true)
  })

  it('treats a done pane with running subagents as busy', () => {
    const subagents = [{ id: 'r-1', agentType: 'reviewer', state: 'idle' as const, startedAt: OLD }]
    expect(isAgentPaneQuiet(entry({ subagents }), quiet)).toBe(false)
  })

  it('treats a non-done pane as busy', () => {
    expect(isAgentPaneQuiet(entry({ state: 'working' }), quiet)).toBe(false)
  })

  it('treats an unsettled dispatch as busy', () => {
    const orchestration = { dispatchStatus: 'dispatched' } as AgentStatusEntry['orchestration']
    expect(isAgentPaneQuiet(entry({ orchestration }), quiet)).toBe(false)
  })

  it('treats in-use and remotely shown panes as busy', () => {
    expect(isAgentPaneQuiet(entry(), { ...quiet, inUse: true })).toBe(false)
    expect(isAgentPaneQuiet(entry(), { ...quiet, shownRemotely: true })).toBe(false)
  })
})
