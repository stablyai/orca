import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { deriveAgentMapLayout } from './agent-map-layout'
import { navigableAgentMapAgents } from './agent-map-navigation'

const NOW = 2_000_000_000

function card(paneKey: string, worktreeId: string, idle: boolean): DashboardCard {
  return {
    paneKey,
    ptyId: `pty-${paneKey}`,
    agentType: 'codex',
    bucket: idle ? 'idle' : 'working',
    dotState: idle ? 'idle' : 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId,
    tabId: `tab-${paneKey}`,
    leafId: `leaf-${paneKey}`,
    repoName: 'Orca',
    worktreeName: worktreeId,
    startedAt: NOW - 60_000,
    finishedAt: idle ? NOW - 30_000 : null,
    stateChangedAt: NOW - 30_000,
    unseen: false
  }
}

describe('agent map keyboard navigation visibility', () => {
  it('excludes every aggregated worktree and restores a selected quiet worktree', () => {
    const quietCards = Array.from({ length: 5 }, (_, index) =>
      card(`quiet-${index}`, 'quiet-worktree', true)
    )
    const active = card('active', 'active-worktree', false)
    const layout = deriveAgentMapLayout([...quietCards, active], NOW)

    expect(
      navigableAgentMapAgents(layout, 1, true, null).map((agent) => agent.card.paneKey)
    ).toEqual(['active'])
    expect(navigableAgentMapAgents(layout, 1, true, 'quiet-0')).toHaveLength(6)
  })
})
