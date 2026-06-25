/* eslint-disable max-lines -- Why: this suite shares a broad mocked sidebar
   harness across compact/full mode, lineage, and image-note cases. */
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

type MockAgentOptions = {
  paneKey?: string
  tabId?: string
  agentType?: string
  rowSource?: DashboardAgentRowData['rowSource']
  state?: string
  startedAt?: number
  prompt?: string
  lastAssistantMessage?: string
  stateStartedAt?: number
  terminalHandle?: string
  orchestration?: {
    parentPaneKey?: string
    parentTerminalHandle?: string
    coordinatorHandle?: string
  }
  lineage?: {
    depth: number
    isFirstSibling: boolean
    isLastSibling: boolean
    childCount: number
  }
}

function mockAgent({
  paneKey = 'tab-1:1',
  tabId = paneKey.split(':')[0],
  agentType,
  rowSource,
  state = 'working',
  startedAt,
  prompt,
  lastAssistantMessage,
  stateStartedAt = 1000,
  terminalHandle,
  orchestration,
  lineage
}: MockAgentOptions = {}): unknown {
  return {
    paneKey,
    tab: { id: tabId },
    agentType,
    rowSource,
    state,
    startedAt,
    entry: {
      prompt,
      lastAssistantMessage,
      state,
      stateStartedAt,
      stateHistory: prompt === undefined ? undefined : [],
      terminalHandle,
      orchestration
    },
    lineage
  }
}

let mockAgents: unknown[] = [mockAgent()]
let mockFocusedAgentPaneKey: string | null = null
let mockAgentActivityDisplayMode: 'compact' | 'full' | undefined
let mockPromptCacheTimerEnabled = true
let mockPromptCacheTtlMs = 60_000
let mockCacheTimerByKey: Record<string, number | null> = {}
let capturedRowActivations: {
  paneKey: string
  onActivate: (tabId: string, paneKey: string) => void
}[] = []

const activationMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  activateTabAndFocusPane: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentActivityDisplayMode: mockAgentActivityDisplayMode,
      acknowledgedAgentsByPaneKey: {},
      cacheTimerByKey: mockCacheTimerByKey,
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      acknowledgeAgents: vi.fn(),
      agentSendPopoverTargetMode: null,
      agentStatusByPaneKey: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sendPromptToSidebarAgentTarget: vi.fn(),
      settings: {
        promptCacheTimerEnabled: mockPromptCacheTimerEnabled,
        promptCacheTtlMs: mockPromptCacheTtlMs
      }
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activationMocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: activationMocks.activateTabAndFocusPane
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
  default: ({
    agent,
    isFocusedPane,
    sendTargetStatus,
    sendTargetDisabledReason,
    onSendTargetClick,
    childAgentCount,
    childAgentsExpanded,
    onToggleChildAgents,
    reserveDisclosureGutter,
    onActivate
  }: {
    agent: { paneKey: string }
    isFocusedPane?: boolean
    sendTargetStatus?: 'eligible' | 'disabled' | 'sending'
    sendTargetDisabledReason?: string
    onSendTargetClick?: (paneKey: string) => void
    childAgentCount?: number
    childAgentsExpanded?: boolean
    onToggleChildAgents?: () => void
    reserveDisclosureGutter?: boolean
    onActivate: (tabId: string, paneKey: string) => void
  }) => {
    capturedRowActivations.push({ paneKey: agent.paneKey, onActivate })
    return (
      <div
        data-testid="agent-row"
        data-focused={isFocusedPane ? 'true' : 'false'}
        data-agent-send-target={sendTargetStatus}
        data-disabled-reason={sendTargetDisabledReason}
        data-has-send-handler={typeof onSendTargetClick === 'function' ? 'true' : 'false'}
        data-pane-key={agent.paneKey}
        data-reserve-disclosure-gutter={reserveDisclosureGutter ? 'true' : 'false'}
      >
        {agent.paneKey}
        {typeof childAgentCount === 'number' && childAgentCount > 0 ? (
          <button
            type="button"
            aria-label={`${childAgentsExpanded ? 'Hide' : 'Show'} ${childAgentCount} child ${
              childAgentCount === 1 ? 'agent' : 'agents'
            }`}
            aria-expanded={childAgentsExpanded ?? false}
            onClick={onToggleChildAgents}
          >
            +{childAgentCount}
          </button>
        ) : null}
      </div>
    )
  }
}))

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => mockFocusedAgentPaneKey)
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

describe('WorktreeCardAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgents = [mockAgent()]
    mockFocusedAgentPaneKey = null
    mockAgentActivityDisplayMode = undefined
    mockPromptCacheTimerEnabled = true
    mockPromptCacheTtlMs = 60_000
    mockCacheTimerByKey = {}
    capturedRowActivations = []
  })

  it('renders ordinary rows in full mode without a child disclosure', async () => {
    mockAgentActivityDisplayMode = 'full'
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Agents"')
    expect(markup).toContain('data-testid="agent-row"')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('aria-expanded')
  }, 30_000)

  it('uses compact mode when the display preference is absent', async () => {
    mockAgents = [mockAgent({ agentType: 'codex', startedAt: 1000, prompt: 'Run tests' })]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="group"')
    expect(markup).toContain('Run tests')
    expect(markup).toContain('title="Codex"')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('dims non-focused compact agent row text', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'Run tests',
        lastAssistantMessage: 'Inspecting changes'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('<span class="text-muted-foreground/90">Run tests</span>')
    expect(markup).toContain('<span class="text-muted-foreground/65"> - Inspecting changes</span>')
    expect(markup).not.toContain('data-focused-agent-pane="true"')
    expect(markup).not.toContain('<span class="text-foreground">Run tests</span>')
  })

  it('keeps focused compact agent row text legible', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockFocusedAgentPaneKey = 'tab-1:1'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'Focused prompt',
        lastAssistantMessage: 'Reading output'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-focused-agent-pane="true"')
    expect(markup).toContain('<span class="text-foreground">Focused prompt</span>')
    expect(markup).toContain('<span class="text-foreground/70"> - Reading output</span>')
    expect(markup).not.toContain('<span class="text-muted-foreground/90">Focused prompt</span>')
  })

  it('shows a matching pane prompt-cache timer before the compact row age', async () => {
    mockAgentActivityDisplayMode = 'compact'
    const paneKey = makePaneKey('tab-1', LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'tab-1',
        agentType: 'claude',
        startedAt: 1000,
        prompt: 'Resume Claude'
      })
    ]
    mockCacheTimerByKey = { [paneKey]: 10_000 }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    const timerIndex = markup.indexOf('Prompt cache expires in 1:00')
    const ageIndex = markup.indexOf('>now</span>')

    expect(timerIndex).toBeGreaterThanOrEqual(0)
    expect(ageIndex).toBeGreaterThanOrEqual(0)
    expect(timerIndex).toBeLessThan(ageIndex)
  })

  it('does not show a prompt-cache timer on a nonmatching compact row', async () => {
    mockAgentActivityDisplayMode = 'compact'
    const paneKey = makePaneKey('tab-1', LEAF_A)
    const otherPaneKey = makePaneKey('tab-1', LEAF_B)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'tab-1',
        agentType: 'claude',
        startedAt: 1000,
        prompt: 'No timer here'
      })
    ]
    mockCacheTimerByKey = { [otherPaneKey]: 10_000 }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('No timer here')
    expect(markup).not.toContain('Prompt cache expires')
  })

  it('does not show a prompt-cache timer when the feature is disabled', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockPromptCacheTimerEnabled = false
    const paneKey = makePaneKey('tab-1', LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'tab-1',
        agentType: 'claude',
        startedAt: 1000,
        prompt: 'Disabled timer'
      })
    ]
    mockCacheTimerByKey = { [paneKey]: 10_000 }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('Disabled timer')
    expect(markup).not.toContain('Prompt cache expires')
  })

  it('keeps hidden retained compact rows from rendering prompt-cache timers', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)
    mockCacheTimerByKey = { [paneKey]: 10_000 }
    const { CompactAgentRow } = await import('./worktree-card-compact-agents')

    const markup = renderToStaticMarkup(
      <CompactAgentRow
        agent={
          mockAgent({
            paneKey,
            tabId: 'tab-1',
            agentType: 'claude',
            startedAt: 1000,
            prompt: 'Collapsed child'
          }) as DashboardAgentRowData
        }
        now={2000}
        onActivate={vi.fn()}
        cacheTimerActive={false}
      />
    )

    expect(markup).toContain('Collapsed child')
    expect(markup).not.toContain('Prompt cache expires')
  })

  it('marks only the focused agent row', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockFocusedAgentPaneKey = 'tab-1:2'
    mockAgents = [mockAgent({ paneKey: 'tab-1:1' }), mockAgent({ paneKey: 'tab-1:2' })]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-focused="false"')
    expect(markup).toContain('data-pane-key="tab-1:1"')
    expect(markup).toContain('data-focused="true"')
    expect(markup).toContain('data-pane-key="tab-1:2"')
  })

  it('keeps retained completion rows passive when activated', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [mockAgent({ rowSource: 'retained', state: 'done' })]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    expect(capturedRowActivations).toHaveLength(1)
    capturedRowActivations[0].onActivate('tab-1', 'tab-1:1')

    expect(activationMocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(activationMocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('shows orchestration child agent rows under their parent by default', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent:1',
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 1
        }
      }),
      mockAgent({
        paneKey: 'tab-child:1',
        state: 'done',
        stateStartedAt: 1500,
        orchestration: { parentPaneKey: 'tab-parent:1' },
        lineage: {
          depth: 1,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 0
        }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('data-pane-key="tab-parent:1"')
    expect(markup).toContain('data-pane-key="tab-child:1"')
    expect(markup).toContain('data-pane-key="tab-child:1" data-reserve-disclosure-gutter="false"')
    expect(markup).toContain('aria-label="Hide 1 child agent"')
    expect(markup).toContain('aria-expanded="true"')
  })

  it('shows orchestration children under a retained parent matched by terminal handle', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent:1',
        terminalHandle: 'term-parent'
      }),
      mockAgent({
        paneKey: 'tab-child:1',
        state: 'done',
        stateStartedAt: 1500,
        orchestration: { parentTerminalHandle: 'term-parent' }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('data-pane-key="tab-parent:1"')
    expect(markup).toContain('data-pane-key="tab-child:1"')
    expect(markup).toContain('aria-label="Hide 1 child agent"')
  })

  it('shows orchestration children under a visible coordinator when parent handle is absent', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent:1',
        terminalHandle: 'term-coordinator'
      }),
      mockAgent({
        paneKey: 'tab-child:1',
        state: 'done',
        stateStartedAt: 1500,
        orchestration: { coordinatorHandle: 'term-coordinator' }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('data-pane-key="tab-parent:1"')
    expect(markup).toContain('data-pane-key="tab-child:1"')
    expect(markup).toContain('aria-label="Hide 1 child agent"')
  })

  it('keeps partially cyclic orchestration rows visible as flat roots', async () => {
    mockAgentActivityDisplayMode = 'full'
    mockAgents = [
      mockAgent({ paneKey: 'tab-root:1' }),
      mockAgent({
        paneKey: 'tab-cycle-a:1',
        stateStartedAt: 1200,
        orchestration: { parentPaneKey: 'tab-cycle-b:1' },
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: false,
          childCount: 1
        }
      }),
      mockAgent({
        paneKey: 'tab-cycle-b:1',
        state: 'done',
        stateStartedAt: 1300,
        orchestration: { parentPaneKey: 'tab-cycle-a:1' },
        lineage: {
          depth: 1,
          isFirstSibling: false,
          isLastSibling: true,
          childCount: 1
        }
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-pane-key="tab-root:1"')
    expect(markup).toContain('data-pane-key="tab-cycle-a:1"')
    expect(markup).toContain('data-pane-key="tab-cycle-b:1"')
    expect(markup).not.toContain('aria-label="Show 1 child agent"')
  })

  it('does not render the labeled wrapper when there are no agent rows', async () => {
    mockAgents = []
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toBe('')
  })

  it('renders a compact summary affordance for two flat agents', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({ agentType: 'codex', state: 'done', startedAt: 1000, prompt: 'First agent' }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Second agent'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('All 2 agents done')
    expect(markup).toContain('Expand All 2 agents done')
    expect(markup).not.toContain('title="Codex done"')
    expect(markup).not.toContain('title="Claude done"')
    expect(markup).not.toContain('>2 done<')
    expect(markup).not.toContain('First agent')
    expect(markup).not.toContain('Second agent')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('does not show a prompt-cache timer on a collapsed compact summary row', async () => {
    mockAgentActivityDisplayMode = 'compact'
    const paneKey = makePaneKey('tab-1', LEAF_A)
    mockAgents = [
      mockAgent({
        paneKey,
        tabId: 'tab-1',
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'First agent'
      }),
      mockAgent({
        paneKey: makePaneKey('tab-1', LEAF_B),
        tabId: 'tab-1',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Second agent'
      })
    ]
    mockCacheTimerByKey = { [paneKey]: 10_000 }
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('All 2 agents done')
    expect(markup).not.toContain('Prompt cache expires')
    expect(markup).not.toContain('compact-agent-row')
  })

  it('keeps compact agent messages with trusted data image markdown to the single-line preview', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: `${'Detailed result. '.repeat(400)}\n\n![Image #1](data:image/png;base64,abc123)`
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('compact-agent-row')
    expect(markup).toContain('group/compact-agent-row')
    expect(markup).toContain('flex h-6 items-center gap-1')
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('max-h-36')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('keeps compact agent messages with trusted blob image markdown to the single-line preview', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: 'Result:\n\n![Image #1](blob:orca-preview-1)'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('flex h-6 items-center gap-1')
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('max-h-36')
  })

  it('keeps reference-style compact agent image markdown to the single-line preview', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: [
          'Result:',
          '',
          '![Image #1][trusted-screenshot]',
          '',
          '[trusted-screenshot]: data:image/png;base64,abc123 "preview"'
        ].join('\n')
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('flex h-6 items-center gap-1')
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('max-h-36')
  })

  it('keeps untrusted compact agent image markdown to the single-line preview', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'done',
        startedAt: 1000,
        prompt: 'Check screenshot',
        lastAssistantMessage: `${'Detailed result. '.repeat(400)}\n\n![Image #1](https://example.com/screenshot.png)`
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('flex h-6 items-center gap-1')
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('max-h-36')
    expect(markup).not.toContain('href="https://example.com/screenshot.png"')
  })

  it('renders a compact summary affordance for multiple flat agents', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        agentType: 'codex',
        state: 'waiting',
        startedAt: 1000,
        prompt: 'Pick a layout'
      }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        startedAt: 1500,
        stateStartedAt: 1500,
        prompt: 'Run tests'
      }),
      mockAgent({
        paneKey: 'tab-1:3',
        agentType: 'gemini',
        state: 'done',
        startedAt: 1700,
        stateStartedAt: 1700,
        prompt: 'Review spacing'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('-space-x-0.5')
    expect(markup).toContain('inline-flex size-4 items-center justify-center')
    expect(markup).toContain('width="13"')
    expect(markup).toContain('3 agents: 1 waiting, 1 working, 1 done')
    expect(markup).toContain('Expand 3 agents: 1 waiting, 1 working, 1 done')
    expect(markup).not.toContain('title="Codex waiting"')
    expect(markup).not.toContain('title="Claude working"')
    expect(markup).not.toContain('title="Gemini done"')
    expect(markup).not.toContain('data-testid="agent-row"')
  })

  it('avoids repeating the total when every compact summary agent has the same state', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({ agentType: 'codex', state: 'done', startedAt: 1000, prompt: 'One' }),
      mockAgent({
        paneKey: 'tab-1:2',
        agentType: 'claude',
        state: 'done',
        startedAt: 1500,
        prompt: 'Two'
      }),
      mockAgent({
        paneKey: 'tab-1:3',
        agentType: 'gemini',
        state: 'done',
        startedAt: 1700,
        prompt: 'Three'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('All 3 agents done')
    expect(markup).toContain('Expand All 3 agents done')
    expect(markup).not.toContain('3 agents: 3 done')
    expect(markup).not.toContain('>+3<')
  })

  it('prioritizes agent varieties in compact summary icons', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      ['tab-1:1', 'codex', 'One'],
      ['tab-1:2', 'codex', 'Two'],
      ['tab-1:3', 'codex', 'Three'],
      ['tab-1:4', 'gemini', 'Four'],
      ['tab-1:5', 'claude', 'Five']
    ].map(([paneKey, agentType, prompt]) =>
      mockAgent({ paneKey, agentType, startedAt: 1000, prompt })
    )
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)
    const iconTitles = [...markup.matchAll(/title="([^"]+)"/g)].map((match) => match[1])

    expect(iconTitles).toEqual([])
    expect(markup).not.toContain('>5 working<')
    expect(markup).toContain('>+2<')
  })

  it('rotates the compact summary chevron when collapsed', async () => {
    const { CompactAgentSummaryButton } = await import('./worktree-card-compact-agents')
    const agents = [
      mockAgent({ paneKey: 'tab-1:1', agentType: 'codex', startedAt: 1000, prompt: 'One' })
    ] as DashboardAgentRowData[]

    const markup = renderToStaticMarkup(
      <CompactAgentSummaryButton
        agents={agents}
        subjectLabel="1 agent"
        expanded={false}
        onToggle={vi.fn()}
      />
    )

    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain(
      'lucide-chevron-down size-3 shrink-0 transition-transform duration-150 -rotate-90'
    )
  })

  it('uses a neutral compact summary label while expanded', async () => {
    const { CompactAgentSummaryButton } = await import('./worktree-card-compact-agents')
    const agents = [
      ['tab-1:1', 'codex', 'One'],
      ['tab-1:2', 'codex', 'Two'],
      ['tab-1:3', 'codex', 'Three'],
      ['tab-1:4', 'gemini', 'Four'],
      ['tab-1:5', 'claude', 'Five']
    ].map(([paneKey, agentType, prompt]) =>
      mockAgent({ paneKey, agentType, startedAt: 1000, prompt })
    ) as DashboardAgentRowData[]

    const markup = renderToStaticMarkup(
      <CompactAgentSummaryButton
        agents={agents}
        subjectLabel="5 agents"
        expanded
        onToggle={vi.fn()}
      />
    )

    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Collapse 5 agents')
    expect(markup).toContain('compact-agent-summary-button-expanded')
    expect(markup).toContain('>5 agents<')
    expect(markup).not.toContain('>+2<')
    expect(markup).not.toContain('Expand All 5 agents working')
  })

  it('can slightly indent expanded compact summary content', async () => {
    const { CompactAgentExpansion } = await import('./worktree-card-compact-agents')

    const markup = renderToStaticMarkup(
      <CompactAgentExpansion expanded contentClassName="pl-1">
        <div>Agent row</div>
      </CompactAgentExpansion>
    )

    expect(markup).toContain('compact-agent-expansion-content flex flex-col gap-0.5 pt-0.5 pl-1')
  })

  it('summarizes compact lineage by parent rows before revealing children', async () => {
    mockAgentActivityDisplayMode = 'compact'
    mockAgents = [
      mockAgent({
        paneKey: 'tab-parent-a:1',
        agentType: 'codex',
        startedAt: 1000,
        prompt: 'Parent A'
      }),
      mockAgent({
        paneKey: 'tab-child-a:1',
        agentType: 'claude',
        state: 'done',
        startedAt: 1100,
        stateStartedAt: 1100,
        prompt: 'Child A',
        orchestration: { parentPaneKey: 'tab-parent-a:1' }
      }),
      mockAgent({
        paneKey: 'tab-parent-b:1',
        agentType: 'gemini',
        state: 'waiting',
        startedAt: 1200,
        stateStartedAt: 1200,
        prompt: 'Parent B'
      }),
      mockAgent({
        paneKey: 'tab-child-b:1',
        agentType: 'codex',
        startedAt: 1300,
        stateStartedAt: 1300,
        prompt: 'Child B',
        orchestration: { parentPaneKey: 'tab-parent-b:1' }
      }),
      mockAgent({
        paneKey: 'tab-parent-c:1',
        agentType: 'codex',
        state: 'done',
        startedAt: 1400,
        stateStartedAt: 1400,
        prompt: 'Parent C'
      })
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-compact-agent-list="true"')
    expect(markup).toContain('role="tree"')
    expect(markup).toContain('3 agents: 1 waiting, 1 working, 1 done')
    expect(markup).not.toContain('title="Gemini waiting"')
    expect(markup).not.toContain('title="Codex working"')
    expect(markup).not.toContain('title="Codex done"')
    expect(markup).not.toContain('Parent A')
    expect(markup).not.toContain('Child A')
    expect(markup).not.toContain('compact-agent-row')
  })
})
