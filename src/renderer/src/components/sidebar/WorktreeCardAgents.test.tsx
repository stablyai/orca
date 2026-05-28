import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockAgents: unknown[] = [
  {
    paneKey: 'tab-1:1',
    tab: { id: 'tab-1' },
    state: 'working',
    entry: {
      stateStartedAt: 1000,
      orchestration: undefined
    }
  }
]
let mockFocusedAgentPaneKey: string | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      acknowledgedAgentsByPaneKey: {},
      dropAgentStatus: vi.fn(),
      dismissRetainedAgent: vi.fn(),
      acknowledgeAgents: vi.fn()
    })
}))

vi.mock('./useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: vi.fn(() => mockAgents)
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: vi.fn(() => 2000)
}))

vi.mock('@/components/dashboard/DashboardAgentRow', () => ({
  default: ({
    agent,
    isFocusedPane,
    childAgentCount,
    childAgentsExpanded,
    onToggleChildAgents
  }: {
    agent: { paneKey: string }
    isFocusedPane?: boolean
    childAgentCount?: number
    childAgentsExpanded?: boolean
    onToggleChildAgents?: () => void
  }) => (
    <div
      data-testid="agent-row"
      data-focused={isFocusedPane ? 'true' : 'false'}
      data-pane-key={agent.paneKey}
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
    mockAgents = [
      {
        paneKey: 'tab-1:1',
        tab: { id: 'tab-1' },
        state: 'working',
        entry: {
          stateStartedAt: 1000,
          orchestration: undefined
        }
      }
    ]
    mockFocusedAgentPaneKey = null
  })

  it('renders ordinary rows in a labeled group without a child disclosure', async () => {
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Agents"')
    expect(markup).toContain('data-testid="agent-row"')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('aria-expanded')
  })

  it('marks only the focused agent row', async () => {
    mockFocusedAgentPaneKey = 'tab-1:2'
    mockAgents = [
      {
        paneKey: 'tab-1:1',
        tab: { id: 'tab-1' },
        entry: {
          stateStartedAt: 1000
        }
      },
      {
        paneKey: 'tab-1:2',
        tab: { id: 'tab-1' },
        entry: {
          stateStartedAt: 1000
        }
      }
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('data-focused="false" data-pane-key="tab-1:1"')
    expect(markup).toContain('data-focused="true" data-pane-key="tab-1:2"')
  })

  it('collapses orchestration child agent rows behind a parent disclosure by default', async () => {
    mockAgents = [
      {
        paneKey: 'tab-parent:1',
        tab: { id: 'tab-parent' },
        state: 'working',
        entry: {
          stateStartedAt: 1000,
          orchestration: undefined
        },
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 1
        }
      },
      {
        paneKey: 'tab-child:1',
        tab: { id: 'tab-child' },
        state: 'done',
        entry: {
          stateStartedAt: 1500,
          orchestration: {
            parentPaneKey: 'tab-parent:1'
          }
        },
        lineage: {
          depth: 1,
          isFirstSibling: true,
          isLastSibling: true,
          childCount: 0
        }
      }
    ]
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toContain('role="tree"')
    expect(markup).toContain('data-pane-key="tab-parent:1"')
    expect(markup).not.toContain('data-pane-key="tab-child:1"')
    expect(markup).toContain('aria-label="Show 1 child agent"')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('keeps partially cyclic orchestration rows visible as flat roots', async () => {
    mockAgents = [
      {
        paneKey: 'tab-root:1',
        tab: { id: 'tab-root' },
        state: 'working',
        entry: {
          stateStartedAt: 1000,
          orchestration: undefined
        }
      },
      {
        paneKey: 'tab-cycle-a:1',
        tab: { id: 'tab-cycle-a' },
        state: 'working',
        entry: {
          stateStartedAt: 1200,
          orchestration: {
            parentPaneKey: 'tab-cycle-b:1'
          }
        },
        lineage: {
          depth: 0,
          isFirstSibling: true,
          isLastSibling: false,
          childCount: 1
        }
      },
      {
        paneKey: 'tab-cycle-b:1',
        tab: { id: 'tab-cycle-b' },
        state: 'done',
        entry: {
          stateStartedAt: 1300,
          orchestration: {
            parentPaneKey: 'tab-cycle-a:1'
          }
        },
        lineage: {
          depth: 1,
          isFirstSibling: false,
          isLastSibling: true,
          childCount: 1
        }
      }
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
})
