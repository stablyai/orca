import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getCompactAgentSecondary } from './worktree-card-compact-agent-secondary'

function makeAgent(overrides?: Partial<DashboardAgentRow>): DashboardAgentRow {
  const paneKey = makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222')
  const tab: TerminalTab = {
    id: 'tab-1',
    worktreeId: 'repo::/repo/main',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const baseEntry: AgentStatusEntry = {
    paneKey,
    state: 'working',
    stateStartedAt: 1000,
    updatedAt: 1000,
    stateHistory: [],
    prompt: 'do work',
    agentType: 'claude'
  }
  const { entry: entryOverrides, ...rowOverrides } = overrides ?? {}
  return {
    paneKey,
    entry: { ...baseEntry, ...entryOverrides },
    tab,
    agentType: 'claude',
    rowSource: 'live',
    state: 'working',
    startedAt: 1000,
    ...rowOverrides
  }
}

describe('getCompactAgentSecondary', () => {
  it('surfaces live worktree mismatch alone when there is no tool detail', () => {
    expect(
      getCompactAgentSecondary(
        makeAgent({
          liveWorktreeMismatchLabel: 'in worktree-foo',
          state: 'waiting'
        })
      )
    ).toBe('in worktree-foo')
  })

  it('prefixes mismatch before tool detail while working', () => {
    expect(
      getCompactAgentSecondary(
        makeAgent({
          liveWorktreeMismatchLabel: 'in worktree-foo',
          entry: {
            paneKey: makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222'),
            state: 'working',
            stateStartedAt: 1000,
            updatedAt: 1000,
            stateHistory: [],
            prompt: 'do work',
            agentType: 'claude',
            toolName: 'Edit',
            toolInput: 'src/a.ts'
          }
        })
      )
    ).toBe('in worktree-foo · Edit: src/a.ts')
  })

  it('keeps existing tool secondary when there is no mismatch', () => {
    expect(
      getCompactAgentSecondary(
        makeAgent({
          entry: {
            paneKey: makePaneKey('tab-1', '22222222-2222-4222-8222-222222222222'),
            state: 'working',
            stateStartedAt: 1000,
            updatedAt: 1000,
            stateHistory: [],
            prompt: 'do work',
            agentType: 'claude',
            toolName: 'Bash'
          }
        })
      )
    ).toBe('Bash')
  })

  it('falls back to agent type label without mismatch detail', () => {
    expect(getCompactAgentSecondary(makeAgent({ state: 'done' }))).toBe('Claude')
  })
})
