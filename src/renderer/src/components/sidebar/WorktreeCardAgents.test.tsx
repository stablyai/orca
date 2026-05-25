import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockAgents = [
  {
    paneKey: 'tab-1:1',
    tab: { id: 'tab-1' },
    entry: {
      stateStartedAt: 1000
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
  default: ({ agent, isFocusedPane }: { agent: { paneKey: string }; isFocusedPane?: boolean }) => (
    <div data-testid="agent-row" data-focused={isFocusedPane ? 'true' : 'false'}>
      {agent.paneKey}
    </div>
  )
}))

vi.mock('./focused-agent-row-highlight', () => ({
  useFocusedAgentPaneKey: vi.fn(() => mockFocusedAgentPaneKey)
}))

describe('WorktreeCardAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgents = [
      {
        paneKey: 'tab-1:1',
        tab: { id: 'tab-1' },
        entry: {
          stateStartedAt: 1000
        }
      }
    ]
    mockFocusedAgentPaneKey = null
  })

  it('renders rows in a labeled group without the removed per-card toggle header', async () => {
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

    expect(markup).toContain('data-focused="false">tab-1:1')
    expect(markup).toContain('data-focused="true">tab-1:2')
  })

  it('does not render the labeled wrapper when there are no agent rows', async () => {
    mockAgents = []
    const { default: WorktreeCardAgents } = await import('./WorktreeCardAgents')

    const markup = renderToStaticMarkup(<WorktreeCardAgents worktreeId="wt-1" />)

    expect(markup).toBe('')
  })
})
