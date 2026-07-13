import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  parseAgentStatusPaneIdentity,
  resolveAgentStatusWorktreeId
} from './agent-status-worktree-attribution'

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

describe('agent status worktree attribution', () => {
  it('uses the pane tab before a stale worktree stamp', () => {
    expect(
      resolveAgentStatusWorktreeId(
        entry({ worktreeId: 'stale-worktree' }),
        new Map([['tab-1', 'current-worktree']])
      )
    ).toBe('current-worktree')
  })

  it('falls back to a parent pane tab for a pre-mirror worker', () => {
    expect(
      resolveAgentStatusWorktreeId(
        entry({
          paneKey: 'worker-tab:22222222-2222-4222-8222-222222222222',
          orchestration: {
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            parentPaneKey: 'parent-tab:1'
          }
        }),
        new Map([['parent-tab', 'parent-worktree']])
      )
    ).toBe('parent-worktree')
  })

  it('parses legacy numeric pane identities consistently', () => {
    expect(parseAgentStatusPaneIdentity('tab-1:7')).toEqual({ tabId: 'tab-1', paneId: '7' })
  })
})
