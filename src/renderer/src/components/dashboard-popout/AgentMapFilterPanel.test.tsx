// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { ALL_AGENT_MAP_STATES, emptyAgentMapFilterState } from './agent-map-quick-views'
import { AgentMapFilterPanel } from './AgentMapFilterPanel'
import type { AgentMapFilterControls } from './useAgentMapFilters'

function card(agentType: string, paneKey: string): DashboardCard {
  return {
    paneKey,
    ptyId: paneKey,
    agentType,
    bucket: 'working',
    dotState: 'working',
    task: '',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Agent map',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    hostKind: agentType === 'codex' ? 'local' : 'ssh'
  }
}

function controls(): AgentMapFilterControls {
  return {
    ...emptyAgentMapFilterState(['claude', 'codex']),
    states: new Set(ALL_AGENT_MAP_STATES),
    activeCount: 0,
    toggleState: vi.fn(),
    resetStates: vi.fn(),
    toggleAgentType: vi.fn(),
    setTimeRange: vi.fn(),
    resetTimeRanges: vi.fn(),
    setUnreadOnly: vi.fn(),
    setOrchestrationOnly: vi.fn(),
    applyQuickView: vi.fn(),
    reset: vi.fn()
  }
}

describe('AgentMapFilterPanel', () => {
  it('offers agent filtering without a host section', () => {
    const cards = [card('codex', 'codex-pane'), card('claude', 'claude-pane')]
    render(
      <AgentMapFilterPanel
        cards={cards}
        shownCount={cards.length}
        filters={{ projects: [], workspaceStatuses: [], reviewStates: [] }}
        onFiltersChange={vi.fn()}
        map={controls()}
        agentlessWorkspaceCount={0}
        showAgentlessWorkspaces={false}
        onShowAgentlessWorkspacesChange={vi.fn()}
        showOrchestrationLinks
        onShowOrchestrationLinksChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }))

    expect(screen.getByRole('button', { name: /Agents/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Hosts/ })).not.toBeInTheDocument()
  })
})
