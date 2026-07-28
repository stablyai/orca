import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockAgentOptions = {
  paneKey?: string
  agentType?: string
  startedAt?: number
  stateStartedAt?: number
  prompt?: string
  lastAssistantMessage?: string
  liveWorktreeMismatch?: { destinationWorktreeId: string; destinationLabel: string }
}

function mockAgent({
  paneKey = 'tab-1:1',
  agentType,
  startedAt,
  stateStartedAt = 1000,
  prompt,
  lastAssistantMessage,
  liveWorktreeMismatch
}: MockAgentOptions = {}): unknown {
  return {
    paneKey,
    tab: { id: paneKey.split(':')[0] },
    agentType,
    rowSource: 'live',
    liveWorktreeMismatch,
    state: 'working',
    startedAt,
    entry: {
      prompt,
      lastAssistantMessage,
      state: 'working',
      stateStartedAt,
      stateHistory: prompt === undefined ? undefined : []
    }
  }
}

let mockAgents: unknown[] = []

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

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('./prompt-cache-countdown-clock', () => ({
  usePromptCacheCountdownNow: vi.fn(() => 10_000)
}))

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({
  default: ({ agent }: { agent: { paneKey: string } }) => (
    <div data-testid="agent-row" data-pane-key={agent.paneKey} />
  )
}))

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => null)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('WorktreeCardAgents live worktree mismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgents = []
  })

  it('notes the destination worktree on a compact row without dropping its details', async () => {
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'Run tests',
        lastAssistantMessage: 'Inspecting changes',
        liveWorktreeMismatch: {
          destinationWorktreeId: 'wt-scratch',
          destinationLabel: 'scratch-fix'
        }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-agent-live-worktree-mismatch')
    expect(markup).toContain(' · in scratch-fix')
    expect(markup).toContain('<span class="text-muted-foreground/90">Run tests</span>')
    expect(markup).toContain('<span class="text-muted-foreground/65"> - Inspecting changes</span>')
    expect(markup).toContain('title="Run tests · in scratch-fix - Inspecting changes"')
  }, 30_000)

  it('summarizes hidden panes running elsewhere on the collapsed compact affordance', async () => {
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'One',
        liveWorktreeMismatch: {
          destinationWorktreeId: 'wt-scratch',
          destinationLabel: 'scratch-fix'
        }
      }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        startedAt: 1500,
        stateStartedAt: 1500,
        prompt: 'Two',
        liveWorktreeMismatch: {
          destinationWorktreeId: 'wt-other',
          destinationLabel: 'other-fix'
        }
      }),
      mockAgent({
        paneKey: 'tab-1:3',
        agentType: 'gemini',
        startedAt: 1700,
        stateStartedAt: 1700,
        prompt: 'Three'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('data-agent-live-worktree-mismatch-summary')
    expect(markup).toContain('2 elsewhere')
    expect(markup).toContain('2 agents in another worktree')
    expect(markup).not.toContain('3 agents in another worktree')
  })

  it('uses the singular hidden-elsewhere phrasing for a single mismatched pane', async () => {
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'One',
        liveWorktreeMismatch: {
          destinationWorktreeId: 'wt-scratch',
          destinationLabel: 'scratch-fix'
        }
      }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        startedAt: 1500,
        stateStartedAt: 1500,
        prompt: 'Two'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('1 elsewhere')
    expect(markup).toContain('1 agent in another worktree')
  })
})
