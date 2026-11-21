// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from '../activity/worktree-card-agents-expansion-state'
import WorktreeCard from './WorktreeCard'
import type * as AgentActivation from '../activity/use-worktree-agent-activation'

const activate = vi.fn()
vi.mock('../activity/use-worktree-agent-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentActivation>()),
  useWorktreeAgentActivation: () => activate
}))

// Fixed, so no test reads the wall clock.
const now = 1_792_983_600_000
const declineConfirm = async (): Promise<boolean> => false
const AGENT_ITEMS = ['Open', 'Copy Title', expect.stringMatching(/^Mark (Read|Unread)$/)]

function seed(mode: 'compact' | 'full', overrides: Partial<Worktree> = {}): Worktree {
  const worktree = makeWorktree({
    id: `${TEST_REPO.id}::/payoption`,
    repoId: TEST_REPO.id,
    path: '/payoption',
    displayName: 'payoption_opt',
    ...overrides
  })
  const tabs: Tab[] = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ].map((entityId, index) => ({
    id: `agent-tab-${index}`,
    entityId,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    worktreeId: worktree.id,
    groupId: 'group',
    executionHostId: 'local',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: now
  }))
  const [parent, child] = tabs.map((tab) => structuredAgentSessionPaneKey(tab.id, tab.entityId))
  // The second agent is the first's worker, so a child row renders too.
  const entries: AgentStatusEntry[] = [parent, child].map((paneKey, index) => ({
    paneKey,
    worktreeId: worktree.id,
    agentType: 'codex',
    state: 'done',
    prompt: index === 0 ? 'Compare the payment channels' : 'Continue work from the plan',
    updatedAt: now,
    stateStartedAt: now,
    stateHistory: [],
    ...(index === 1
      ? { orchestration: { taskId: 'task', dispatchId: 'dispatch', parentPaneKey: parent } }
      : {})
  }))
  seedWorktreeAgentExpansionStateForTests(worktree.id, {
    expandedLineageParents: new Set([parent]),
    expandedIdleChildGroups: new Set(),
    compactRootListExpanded: true
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    agentActivityDisplayMode: mode,
    unifiedTabsByWorktree: { [worktree.id]: tabs },
    agentStatusByPaneKey: acceptedAgentStatuses(entries.map((entry) => [entry.paneKey, entry]))
  })
  return worktree
}

function renderCard(
  worktree: Worktree,
  options: { selected?: readonly Worktree[]; nestedChild?: Worktree } = {}
): HTMLElement {
  const { selected, nestedChild } = options
  return render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <WorktreeCard
          worktree={worktree}
          repo={TEST_REPO}
          isActive
          nativeDragEnabled={false}
          isMultiSelected={selected !== undefined}
          selectedWorktrees={selected}
          onContextMenuSelect={selected ? () => selected : undefined}
          lineageChildCount={nestedChild ? 1 : 0}
          lineageChildren={
            nestedChild ? (
              <WorktreeCard
                worktree={nestedChild}
                repo={TEST_REPO}
                isActive={false}
                nativeDragEnabled={false}
              />
            ) : undefined
          }
        />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  ).container
}

/** Opens a menu from `target`; returns its label and item labels. */
function openMenuOn(target: Element): { label: string | null; items: string[] } {
  act(() => {
    fireEvent.contextMenu(target, { clientX: 40, clientY: 10 })
  })
  const menus = screen.getAllByRole('menu')
  expect(menus).toHaveLength(1)
  return {
    label: menus[0].querySelector('[data-slot="dropdown-menu-label"]')?.textContent ?? null,
    items: Array.from(menus[0].querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent?.trim() ?? ''
    )
  }
}

function closeMenu(): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
  expect(screen.queryByRole('menu')).toBeNull()
}

function choose(label: string): void {
  const item = screen.getAllByRole('menuitem').find((entry) => entry.textContent === label)
  if (!item) {
    throw new Error(`no ${label}`)
  }
  // A person clicks well after the right-click that opened the menu, outside its guard window.
  const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
  try {
    act(() => {
      fireEvent.click(item)
    })
  } finally {
    later.mockRestore()
  }
}

function surfaceOf(container: HTMLElement): Element {
  const surface = container.querySelector('[data-worktree-card-surface]')
  if (!surface) {
    throw new Error('no card surface')
  }
  return surface
}

/** Finds rows by their own class, not by the marker under test, so removing the marker fails on the menu. */
function agentRows(container: HTMLElement): { root: Element; child: Element } {
  const rows = Array.from(container.querySelectorAll('.agent-disclosure-row'))
  const child = container.querySelector('.agent-disclosure-row.worktree-agent-lineage-child-row')
  const root = rows.find((row) => row !== child)
  if (!root || !child) {
    throw new Error('expected a root agent row and its worker’s child row')
  }
  return { root, child }
}

afterEach(() => {
  cleanup()
  activate.mockReset()
  clearWorktreeAgentExpansionStateForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe.each(['compact', 'full'] as const)('a %s agent row in a workspace card', (mode) => {
  it('opens the Agent menu, while the card header keeps the workspace menu', () => {
    const container = renderCard(seed(mode))
    const header = openMenuOn(surfaceOf(container))
    expect(header.items).toContain('Mute Notifications')
    expect(header.items).toContainEqual(expect.stringMatching(/^Delete/))
    closeMenu()
    const { root, child } = agentRows(container)
    for (const row of [root, child]) {
      const menu = openMenuOn(row)
      expect(menu.label).toBe('Agent')
      expect(menu.items).toEqual(AGENT_ITEMS)
      expect(row.getAttribute('data-agent-row-menu-open')).toBe('true')
      // The row shows that its menu is open, not the whole card.
      expect(surfaceOf(container).hasAttribute('data-worktree-card-menu-open')).toBe(false)
      closeMenu()
    }
  })

  it('treats anything inside the row as the row', () => {
    const container = renderCard(seed(mode))
    const inner = agentRows(container).root.querySelector('button, [tabindex], span')
    expect(inner).toBeTruthy()
    expect(openMenuOn(inner!).items).toEqual(AGENT_ITEMS)
  })

  it('opens the Agent menu on a primary checkout and in a multi-selection, with no Delete', () => {
    const primary = renderCard(seed(mode, { isMainWorktree: true }))
    expect(openMenuOn(agentRows(primary).root).items).toEqual(AGENT_ITEMS)
    closeMenu()
    cleanup()
    const worktree = seed(mode)
    const other = makeWorktree({
      id: `${TEST_REPO.id}::/discount`,
      repoId: TEST_REPO.id,
      path: '/discount',
      displayName: 'discount'
    })
    useAppStore.setState({ worktreesByRepo: { [TEST_REPO.id]: [worktree, other] } })
    const selected = renderCard(worktree, { selected: [worktree, other] })
    expect(openMenuOn(surfaceOf(selected)).items).toContainEqual(
      expect.stringMatching(/^Delete 2 Workspaces/)
    )
    closeMenu()
    expect(openMenuOn(agentRows(selected).root).items).toEqual(AGENT_ITEMS)
  })

  it('opens the agent the row would open', () => {
    const container = renderCard(seed(mode))
    openMenuOn(agentRows(container).root)
    choose('Open')
    expect(activate).toHaveBeenCalledWith('agent-tab-0', expect.stringMatching(/^agent-tab-0:/))
  })

  it('copies the row’s title alone, without its agent name', () => {
    const writeClipboardText = vi.fn<(text: string) => Promise<void>>(async () => {})
    const api = window.api
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    try {
      const container = renderCard(seed(mode))
      const { root } = agentRows(container)
      openMenuOn(root)
      choose('Copy Title')
      // The row reads "Chat - Codex"; only its title is copied.
      expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith('Chat')
      expect(root.textContent).toContain('Chat')
    } finally {
      Object.assign(window, { api })
    }
  })

  it('marks one agent read or unread, in step with the card’s unread state', () => {
    const container = renderCard(seed(mode))
    const { root } = agentRows(container)
    const paneKey = () =>
      Object.keys(useAppStore.getState().acknowledgedAgentsByPaneKey).find((key) =>
        key.startsWith('agent-tab-0:')
      )
    const first = openMenuOn(root).items[2]
    if (first === 'Mark Read') {
      choose('Mark Read')
      expect(paneKey()).toBeDefined()
      expect(openMenuOn(root).items[2]).toBe('Mark Unread')
    }
    choose('Mark Unread')
    expect(openMenuOn(root).items[2]).toBe('Mark Read')
    closeMenu()
    // An unread agent makes its card unread; the card's Mark Read then clears the row.
    expect(openMenuOn(surfaceOf(container)).items).toContain('Mark Read')
    choose('Mark Read')
    expect(openMenuOn(root).items[2]).toBe('Mark Unread')
  })

  it('closes when its agent goes away', () => {
    const container = renderCard(seed(mode))
    openMenuOn(agentRows(container).child)
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: acceptedAgentStatuses([]),
        unifiedTabsByWorktree: {}
      })
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('an agent row in a nested workspace card', () => {
  it('opens its own Agent menu once, and no workspace menu', () => {
    const parent = makeWorktree({
      id: `${TEST_REPO.id}::/planning`,
      repoId: TEST_REPO.id,
      path: '/planning',
      displayName: 'planning'
    })
    const nested = seed('compact')
    useAppStore.setState({ worktreesByRepo: { [TEST_REPO.id]: [parent, nested] } })
    const container = renderCard(parent, { nestedChild: nested })
    const menu = openMenuOn(agentRows(container).root)
    expect(menu.label).toBe('Agent')
    expect(menu.items).toEqual(AGENT_ITEMS)
  })
})
