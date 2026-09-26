import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

// Why: WorktreeCardAgents.test.tsx already sits at the oxlint max-lines cap for
// test files (800), so this integration-only regression lives in its own file
// instead of growing that one. See PR #22870 review: the compact tests there
// force stateStartedAt: 0, which never exercises the isUnvisited wiring that
// WorktreeCardAgents itself passes down to CompactAgentRow.
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      acknowledgedAgentsByPaneKey: {},
      cacheTimerByKey: {},
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      acknowledgeAgents: vi.fn(),
      agentSendPopoverTargetMode: null,
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sendPromptToSidebarAgentTarget: vi.fn(),
      settings: { promptCacheTimerEnabled: true, promptCacheTtlMs: 60_000 }
    })
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => [
    {
      paneKey: 'tab-1:1',
      tab: { id: 'tab-1' },
      agentType: 'codex',
      state: 'working',
      startedAt: 1000,
      entry: {
        prompt: 'Run tests',
        lastAssistantMessage: 'Inspecting changes',
        state: 'working',
        stateStartedAt: 1000,
        stateHistory: []
      }
    }
  ])
}))
vi.mock('@/hooks/use-now', () => ({ useNow: vi.fn(() => 2000) }))
vi.mock('./prompt-cache-countdown-clock', () => ({ usePromptCacheCountdownNow: vi.fn(() => null) }))
vi.mock('@/components/dashboard/DashboardAgentRow', () => ({ default: () => null }))
vi.mock('./focused-agent-row-highlight', () => ({ useFocusedAgentPaneKey: vi.fn(() => null) }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('WorktreeCardAgents unvisited wiring', () => {
  it('bolds a compact agent row through the real isUnvisited wiring, not just CompactAgentRow directly', async () => {
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('font-semibold text-foreground">Run tests</span>')
  })
})
