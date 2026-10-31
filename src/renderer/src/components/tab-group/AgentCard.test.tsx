// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import { tiledPaneFrameClassName } from './tiled-pane-attention'

const storeBox: { state: Record<string, unknown> } = { state: {} }

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(storeBox.state),
    { getState: () => storeBox.state }
  )
  return { useAppStore }
})

vi.mock('../tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: (props: { groupId: string; launchSource?: string }) => (
    <div data-testid="agent-launcher" data-group={props.groupId} data-source={props.launchSource} />
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('lucide-react', async () =>
  (await import('../tab-bar/lucide-icon-stub-fixture')).stubEveryIcon()
)

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: ({ agent }: { agent: string | null }) => <span data-testid="agent-icon">{agent}</span>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { AgentCard } from './AgentCard'

const WORKTREE_ID = 'wt-1'
const CARD_GROUP_ID = 'card-1'
const TAB_ID = 'agent-tab-1'

function makeTab(): Tab {
  return {
    id: TAB_ID,
    entityId: 'session-1',
    groupId: CARD_GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function setState(overrides: { isMaximized?: boolean } = {}): {
  toggleMaximizedAgentCard: ReturnType<typeof vi.fn>
  closeUnifiedTab: ReturnType<typeof vi.fn>
  focusGroup: ReturnType<typeof vi.fn>
  activateTab: ReturnType<typeof vi.fn>
} {
  const toggleMaximizedAgentCard = vi.fn()
  const closeUnifiedTab = vi.fn()
  const focusGroup = vi.fn()
  const activateTab = vi.fn()
  storeBox.state = {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [makeTab()] },
    tabsByWorktree: { [WORKTREE_ID]: [] },
    maximizedGroupIdByWorktree: overrides.isMaximized ? { [WORKTREE_ID]: CARD_GROUP_ID } : {},
    toggleMaximizedAgentCard,
    closeUnifiedTab,
    focusGroup,
    activateTab
  }
  return { toggleMaximizedAgentCard, closeUnifiedTab, focusGroup, activateTab }
}

describe('AgentCard', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the resolved label, agent icon, and an anchored body without data-worktree-id', () => {
    setState()
    const { container } = render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
      />
    )
    expect(screen.getByText('Codex Chat')).not.toBeNull()
    expect(screen.getByTestId('agent-icon').textContent).toBe('codex')
    const body = container.querySelector('[data-tab-group-body-id="card-1"]')
    expect(body).not.toBeNull()
    expect(body?.hasAttribute('data-worktree-id')).toBe(false)
  })

  it('calls toggleMaximizedAgentCard from the enlarge control', () => {
    const { toggleMaximizedAgentCard } = setState()
    render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
      />
    )
    fireEvent.click(screen.getByLabelText('Enlarge agent'))
    expect(toggleMaximizedAgentCard).toHaveBeenCalledWith(WORKTREE_ID, CARD_GROUP_ID)
  })

  it('calls closeUnifiedTab from the close control', () => {
    const { closeUnifiedTab } = setState()
    render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
      />
    )
    fireEvent.click(screen.getByLabelText('Close agent'))
    expect(closeUnifiedTab).toHaveBeenCalledWith(TAB_ID)
  })

  it('opens the launcher menu with the card group and agent_card_plus source', () => {
    setState()
    render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
      />
    )
    const launcher = screen.getByTestId('agent-launcher')
    expect(launcher.getAttribute('data-group')).toBe(CARD_GROUP_ID)
    expect(launcher.getAttribute('data-source')).toBe('agent_card_plus')
  })

  it('focuses the card group when keyboard focus reaches a header control', () => {
    const { focusGroup } = setState()
    render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
      />
    )
    fireEvent.focusIn(screen.getByLabelText('Close agent'))
    expect(focusGroup).toHaveBeenCalledWith(WORKTREE_ID, CARD_GROUP_ID)
  })

  it('uses the dot-palette frame classes for a blocked tone', () => {
    setState()
    const { container } = render(
      <AgentCard
        worktreeId={WORKTREE_ID}
        cardGroupId={CARD_GROUP_ID}
        tabId={TAB_ID}
        isMaximized={false}
        frameTone="blocked"
      />
    )
    expect(container.firstElementChild?.className).toContain(tiledPaneFrameClassName('blocked'))
  })
})
