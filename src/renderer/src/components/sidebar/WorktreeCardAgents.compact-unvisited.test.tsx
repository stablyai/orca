import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockAcknowledgedAgentsByPaneKey: Record<string, number> = {}

const doneAgent = {
  paneKey: 'tab-1:1',
  tab: { id: 'tab-1' },
  agentType: 'codex',
  rowSource: undefined,
  state: 'done',
  startedAt: 500,
  entry: {
    prompt: 'Run tests',
    lastAssistantMessage: 'All green',
    state: 'done',
    stateStartedAt: 1000,
    stateHistory: [],
    orchestration: undefined
  },
  lineage: undefined
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: 'compact',
      acknowledgedAgentsByPaneKey: mockAcknowledgedAgentsByPaneKey,
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
  useWorktreeAgentRows: vi.fn(() => [doneAgent])
}))

vi.mock('@/hooks/use-now', () => ({
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

async function renderCard(): Promise<string> {
  const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')
  return renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
}

// Why: guards the card→row wiring; compact rows previously never received the unvisited flag.
describe('WorktreeCardAgents compact unvisited rows', () => {
  beforeEach(() => {
    mockAcknowledgedAgentsByPaneKey = {}
  })

  it('emphasizes a finished turn acknowledged before it started', async () => {
    mockAcknowledgedAgentsByPaneKey = { 'tab-1:1': 900 }
    const markup = await renderCard()

    expect(markup).toContain('<span class="font-semibold text-foreground">Run tests</span>')
    expect(markup).toContain('data-agent-row-unread-alert=""')
  })

  it('keeps an acknowledged turn muted', async () => {
    mockAcknowledgedAgentsByPaneKey = { 'tab-1:1': 1000 }
    const markup = await renderCard()

    expect(markup).toContain('<span class="text-muted-foreground/90">Run tests</span>')
    expect(markup).not.toContain('data-agent-row-unread-alert=""')
  })
})
