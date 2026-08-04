// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

afterEach(cleanup)

type AgentRowOverrides = Omit<Partial<DashboardAgentRow>, 'entry'> & {
  entry?: Partial<DashboardAgentRow['entry']>
}

function agentRow(overrides: AgentRowOverrides = {}): DashboardAgentRow {
  const row = {
    paneKey: 'parent\u0000subagent:child-1',
    tab: { id: 'tab-1' },
    agentType: 'default',
    rowSource: 'subagent',
    state: 'working',
    startedAt: 1_000,
    entry: {
      prompt: '/root/test_agent',
      state: 'working',
      stateStartedAt: 1_000,
      stateHistory: [],
      model: 'gpt-5.6-sol'
    },
    subagentSession: { id: 'child-1', provider: 'codex', parentPaneKey: 'parent' },
    lineage: { depth: 1, isFirstSibling: true, isLastSibling: true, childCount: 0 }
  } as unknown as DashboardAgentRow
  return {
    ...row,
    ...overrides,
    entry: { ...row.entry, ...overrides.entry }
  } as DashboardAgentRow
}

describe('CompactAgentRow subagent display', () => {
  it('uses a concise child label and keeps canonical metadata in the tooltip', () => {
    render(<CompactAgentRow agent={agentRow()} now={2_000} onActivate={vi.fn()} isCurrentAgent />)

    const row = screen.getByRole('treeitem')
    expect(row.textContent).toContain('test_agent')
    expect(row.textContent).not.toContain('/root/')
    expect(row.textContent).not.toContain('Default')
    expect(row.textContent).not.toContain('gpt-5.6-sol')
    expect(row.getAttribute('title')).toBe('/root/test_agent')
    expect(row.getAttribute('data-subagent-id')).toBe('child-1')
    expect(row.getAttribute('data-current')).toBe('true')
    expect(row.getAttribute('aria-selected')).toBe('true')
  })

  it('keeps an aggregate parent row free of stale child-launch tool text', () => {
    render(
      <CompactAgentRow
        agent={agentRow({
          paneKey: 'parent',
          agentType: 'codex',
          rowSource: 'live',
          entry: {
            prompt: 'Agnes_Core | main',
            state: 'working',
            stateStartedAt: 1_000,
            stateHistory: [],
            toolName: 'collaborationlist_agents'
          },
          lineage: { depth: 0, isFirstSibling: true, isLastSibling: true, childCount: 1 }
        })}
        now={2_000}
        onActivate={vi.fn()}
        childAgentCount={1}
        childAgentsExpanded
        onToggleChildAgents={vi.fn()}
        hideIdentityIcon
      />
    )

    const row = screen.getByRole('treeitem')
    expect(row.textContent).toContain('Agnes_Core | main')
    expect(row.textContent).not.toContain('collaborationlist_agents')
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Hide 1 child agent')
  })
})
