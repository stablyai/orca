import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/rows/dashboard-agent-row'
import { CompactAgentSummaryButton } from './worktree-card-compact-agents'

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => null)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

function agentRow(
  paneKey: string,
  agentType: DashboardAgentRowData['agentType'],
  state: DashboardAgentRowData['state']
): DashboardAgentRowData {
  const row = {
    paneKey,
    tab: { id: paneKey.split(':')[0], worktreeId: 'wt-1' },
    agentType,
    state,
    startedAt: 1000,
    entry: { state, stateStartedAt: 1000 }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The summary button reads only the fields set above.
  return row as unknown as DashboardAgentRowData
}

describe('CompactAgentSummaryButton markup', () => {
  it('renders the collapsed summary with overlapped agent icons unchanged', () => {
    const agents = [
      agentRow('tab-1:1', 'codex', 'working'),
      agentRow('tab-1:2', 'claude', 'working'),
      agentRow('tab-1:3', 'gemini', 'working'),
      agentRow('tab-1:4', 'codex', 'working'),
      agentRow('tab-1:5', 'codex', 'waiting'),
      agentRow('tab-1:6', 'claude', 'done')
    ]

    const markup = renderToStaticMarkup(
      <CompactAgentSummaryButton
        agents={agents}
        subjectLabel="6 agents"
        expanded={false}
        onToggle={vi.fn()}
      />
    )

    expect(markup).toMatchSnapshot()
  })
})
