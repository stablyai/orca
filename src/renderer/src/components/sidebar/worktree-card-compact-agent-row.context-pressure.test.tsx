import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import type { GlobalSettings } from '../../../../shared/types'

let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      cacheTimerByKey: {},
      settings,
      tabsByWorktree: {}
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-tooltip-content="">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import { CompactAgentRow } from './worktree-card-compact-agent-row'

function makeAgent(usedTokens?: number): DashboardAgentRowData {
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  return {
    paneKey,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    agentType: 'claude',
    state: 'working',
    startedAt: 1_000,
    entry: {
      paneKey,
      state: 'working',
      prompt: 'Compact pressure row',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: [],
      agentType: 'claude',
      model: 'claude-sonnet-4-5',
      ...(usedTokens !== undefined ? { contextUsage: { usedTokens, maxTokens: 200_000 } } : {})
    }
  }
}

function renderRow(agent: DashboardAgentRowData): string {
  return renderToStaticMarkup(<CompactAgentRow agent={agent} now={2_000} onActivate={vi.fn()} />)
}

describe('CompactAgentRow context pressure', () => {
  it('shows the per-agent dot next to the trailing metadata when the flag is on', () => {
    settings = { experimentalContextPressure: true }
    const markup = renderRow(makeAgent(195_000))

    expect(markup).toContain('data-context-pressure="critical"')
  })

  it("shows green at 'ok' — per-agent rows carry all three levels", () => {
    settings = { experimentalContextPressure: true }
    expect(renderRow(makeAgent(100_000))).toContain('data-context-pressure="ok"')
  })

  it('renders nothing while the flag is off or without provider data', () => {
    settings = null
    expect(renderRow(makeAgent(195_000))).not.toContain('data-context-pressure')

    settings = { experimentalContextPressure: true }
    expect(renderRow(makeAgent())).not.toContain('data-context-pressure')
  })
})
