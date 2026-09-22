import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Why: a descendant leaf that skips the chevron gutter lands left of its parent's dot, reading flat.

let mockAgents: unknown[] = []

function mockAgent(paneKey: string, prompt: string, parentPaneKey?: string): unknown {
  return {
    paneKey,
    tab: { id: paneKey.split(':')[0] },
    agentType: 'claude',
    rowSource: undefined,
    state: 'working',
    startedAt: 1000,
    entry: {
      prompt,
      state: 'working',
      stateStartedAt: 1000,
      stateHistory: [],
      orchestration: parentPaneKey ? { parentPaneKey } : undefined
    },
    lineage: undefined
  }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      acknowledgedAgentsByPaneKey: {},
      cacheTimerByKey: {},
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      agentSendPopoverTargetMode: null,
      agentStatusByPaneKey: {},
      agentStatusEpoch: 0,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
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

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null,
  usePromptCacheCountdownStartedAt: () => null
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

/** Reserved leading spacers — the chevron itself is a button, so this counts leaves only. */
function countReservedGutters(markup: string): number {
  return markup.match(/<span class="size-4 shrink-0"/g)?.length ?? 0
}

describe('compact agent lineage indentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reserves the chevron gutter on a descendant leaf so it nests past its parent', async () => {
    mockAgents = [
      mockAgent('tab-parent:1', 'Parent'),
      mockAgent('tab-child:1', 'Child', 'tab-parent:1')
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('worktree-agent-lineage-children')
    expect(markup).toContain('compact-agent-child-disclosure-button')
    // The parent owns the chevron, so the single spacer is the child's.
    expect(countReservedGutters(markup)).toBe(1)
  })

  it('reserves the gutter at every depth so nesting compounds', async () => {
    mockAgents = [
      mockAgent('tab-a:1', 'Root'),
      mockAgent('tab-b:1', 'Middle', 'tab-a:1'),
      mockAgent('tab-c:1', 'Leaf', 'tab-b:1')
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    // Root and middle both render chevrons; only the depth-2 leaf reserves a spacer.
    expect(countReservedGutters(markup)).toBe(1)
    expect(markup.match(/worktree-agent-lineage-children/g)).toHaveLength(2)
  })

  it('leaves a lone flat root without a reserved gutter', async () => {
    mockAgents = [mockAgent('tab-solo:1', 'Solo')]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).not.toContain('worktree-agent-lineage-children')
    expect(countReservedGutters(markup)).toBe(0)
  })
})
