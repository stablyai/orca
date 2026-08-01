import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings, TerminalTab } from '../../../../shared/types'
import { TooltipProvider } from '../ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

// Real store hooks read the initial snapshot under renderToStaticMarkup, so the
// experimental settings must come from a mocked store, not setState.
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings,
      tabsByWorktree: {}
    })
}))

import DashboardAgentRow from './DashboardAgentRow'

const NOW = 120_000

function makeAgent(entryOverrides: Partial<AgentStatusEntry> = {}): DashboardAgentRowData {
  const paneKey = 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'working',
    prompt: 'Fix hover scope',
    updatedAt: 60_000,
    stateStartedAt: 60_000,
    agentType: 'claude',
    paneKey,
    stateHistory: [],
    ...entryOverrides
  }
  return {
    paneKey,
    entry,
    tab,
    agentType: entry.agentType ?? 'claude',
    state: entry.state,
    startedAt: entry.stateStartedAt
  }
}

function renderRow(agent: DashboardAgentRowData): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <DashboardAgentRow
        agent={agent}
        onDismiss={vi.fn()}
        onActivate={vi.fn()}
        now={NOW}
        hideIdentityIcon
        hideExpand
      />
    </TooltipProvider>
  )
}

const withContextUsage = (): DashboardAgentRowData =>
  makeAgent({
    model: 'claude-sonnet-4-5',
    contextUsage: { usedTokens: 160_000, maxTokens: 200_000 }
  })

describe('DashboardAgentRow context pressure', () => {
  it('renders nothing while the experimental flag is off', () => {
    settings = null
    expect(renderRow(withContextUsage())).not.toContain('data-context-pressure')

    settings = { experimentalContextPressure: false }
    expect(renderRow(withContextUsage())).not.toContain('data-context-pressure')
  })

  it('shows the traffic light for a session with provider-reported usage', () => {
    settings = { experimentalContextPressure: true }
    const markup = renderRow(withContextUsage())

    // Per-agent rows show every level, so 80% of 200k reads as warning.
    // (Tooltip token/limit detail is asserted in ContextPressureIndicator.test.)
    expect(markup).toContain('data-context-pressure="warning"')
    expect(markup).toContain(
      'aria-label="Context window: 160.0k of 200.0k tokens (80%). Effective context limit: provider-reported. approaching limit"'
    )
  })

  it("shows green at 'ok' on per-agent rows and honors custom thresholds", () => {
    settings = {
      experimentalContextPressure: true,
      contextPressureWarnPercent: 85,
      contextPressureCriticalPercent: 95
    }
    // 80% sits below the raised warn threshold, so the row shows green.
    expect(renderRow(withContextUsage())).toContain('data-context-pressure="ok"')
  })

  it('renders nothing for a session without usage data (honest unknown)', () => {
    settings = { experimentalContextPressure: true }
    expect(renderRow(makeAgent({ model: 'claude-sonnet-4-5' }))).not.toContain(
      'data-context-pressure'
    )
  })
})
