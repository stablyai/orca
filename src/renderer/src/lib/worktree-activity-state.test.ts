import { describe, expect, it } from 'vitest'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from './worktree-activity-state'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'

const NOW = 10_000_000

function makeTab(id: string): Pick<TerminalTab, 'id'> {
  return { id }
}

function makeAgentEntry(
  overrides: Partial<AgentStatusEntry> & { paneKey: string }
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    ...overrides
  }
}

describe('worktree activity state', () => {
  it('keeps a workspace with a running agent active even without a live pty (#7197)', () => {
    const worktreeIdsWithLiveAgent = new Set(['wt-1'])
    expect(
      isInactiveWorkspace(
        'wt-1',
        { 'wt-1': [makeTab('tab-1')] },
        { 'tab-1': [] },
        {},
        worktreeIdsWithLiveAgent
      )
    ).toBe(false)
  })
})

describe('getWorktreeIdsWithLiveAgent', () => {
  it('falls back to the paneKey tabId when worktreeId is absent', () => {
    const entries = {
      'tab-1:00000000-0000-4000-8000-000000000000': makeAgentEntry({
        paneKey: 'tab-1:00000000-0000-4000-8000-000000000000'
      })
    }
    expect(getWorktreeIdsWithLiveAgent(entries, { 'wt-1': [makeTab('tab-1')] }, NOW)).toEqual(
      new Set(['wt-1'])
    )
  })

  it('ignores completed headless agents without an open session', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        state: 'done'
      })
    }

    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set())
  })

  it('ignores stale status left behind after an SSH disconnect', () => {
    const entries = {
      'tab-1:leaf-1': makeAgentEntry({
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'wt-1',
        updatedAt: 0
      })
    }

    expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set())
  })

  it.each(['working', 'blocked', 'waiting'] as const)(
    'keeps a fresh %s agent visible during a PTY gap',
    (state) => {
      const entries = {
        'tab-1:leaf-1': makeAgentEntry({
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1',
          state
        })
      }

      expect(getWorktreeIdsWithLiveAgent(entries, {}, NOW)).toEqual(new Set(['wt-1']))
    }
  )
})
