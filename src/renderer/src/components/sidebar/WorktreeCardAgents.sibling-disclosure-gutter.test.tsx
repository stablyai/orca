import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from './worktree-card-agents-expansion-state'

function mockAgent(
  paneKey: string,
  extras: {
    prompt?: string
    parentPaneKey?: string
  } = {}
): unknown {
  return {
    paneKey,
    tab: { id: paneKey.split(':')[0] },
    agentType: 'codex',
    state: 'working',
    startedAt: 1000,
    entry: {
      prompt: extras.prompt ?? paneKey,
      state: 'working',
      stateStartedAt: 1000,
      stateHistory: [],
      orchestration: extras.parentPaneKey
        ? { parentPaneKey: extras.parentPaneKey }
        : undefined
    }
  }
}

const siblingLineage = [
  mockAgent('tab-parent:1', { prompt: 'Parent session' }),
  mockAgent('tab-child:1', { prompt: 'Sub-agent', parentPaneKey: 'tab-parent:1' }),
  mockAgent('tab-sibling:1', { prompt: 'Sibling session' })
]

let mockAgents: unknown[] = siblingLineage
let mockAgentActivityDisplayMode: 'compact' | 'full' = 'full'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: mockAgentActivityDisplayMode,
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
      settings: { promptCacheTimerEnabled: false, promptCacheTtlMs: 60_000 }
    })
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({
  default: ({
    agent,
    reserveDisclosureGutter
  }: {
    agent: { paneKey: string }
    reserveDisclosureGutter?: boolean
  }) => (
    <div
      data-testid="agent-row"
      data-pane-key={agent.paneKey}
      data-reserve-disclosure-gutter={reserveDisclosureGutter ? 'true' : 'false'}
    />
  )
}))

vi.mock('./worktree-card-compact-agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree-card-compact-agents')>()
  return {
    ...actual,
    CompactAgentRow: ({
      agent,
      reserveDisclosureGutter
    }: {
      agent: { paneKey: string }
      reserveDisclosureGutter?: boolean
    }) => (
      <div
        data-testid="compact-agent-row"
        data-pane-key={agent.paneKey}
        data-reserve-disclosure-gutter={reserveDisclosureGutter ? 'true' : 'false'}
      />
    )
  }
})

describe('WorktreeCardAgents sibling disclosure gutter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgents = siblingLineage
    mockAgentActivityDisplayMode = 'full'
    clearWorktreeAgentExpansionStateForTests()
  })

  it('keeps full-mode sibling roots unshifted when another root has children', async () => {
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-gutter" />)

    expect(markup).toContain('data-pane-key="tab-parent:1" data-reserve-disclosure-gutter="false"')
    expect(markup).toContain('data-pane-key="tab-sibling:1" data-reserve-disclosure-gutter="false"')
    expect(markup).toContain('data-pane-key="tab-child:1" data-reserve-disclosure-gutter="false"')
    expect(markup).not.toContain('data-reserve-disclosure-gutter="true"')
  })

  it('keeps compact sibling roots unshifted when the lineage list is expanded', async () => {
    mockAgentActivityDisplayMode = 'compact'
    seedWorktreeAgentExpansionStateForTests('wt-gutter', {
      compactRootListExpanded: true,
      collapsedLineageParents: new Set()
    })
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-gutter" />)

    expect(markup).toContain('data-testid="compact-agent-row"')
    expect(markup).toContain('data-pane-key="tab-parent:1" data-reserve-disclosure-gutter="false"')
    expect(markup).toContain('data-pane-key="tab-sibling:1" data-reserve-disclosure-gutter="false"')
    expect(markup).toContain('data-pane-key="tab-child:1" data-reserve-disclosure-gutter="false"')
    expect(markup).not.toContain('data-reserve-disclosure-gutter="true"')
  })
})
