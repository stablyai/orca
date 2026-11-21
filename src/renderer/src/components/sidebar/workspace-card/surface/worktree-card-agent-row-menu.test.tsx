// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
import { WORKSPACE_AGENT_ROW_ATTR } from '../../workspace-actions/context-menu/workspace-agent-row-marker'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from '../activity/worktree-card-agents-expansion-state'
import WorktreeCard from './WorktreeCard'

// Fixed, so no test reads the wall clock.
const now = 1_792_983_600_000
const declineConfirm = async (): Promise<boolean> => false
const DELETE_GROUP_LABELS = [
  'Delete',
  'Delete Worktree',
  'Delete with Descendants…',
  'Remove Workspace',
  'Remove Project from Orca',
  // Shown in place of Delete while one is pending.
  'Deleting…'
]

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
    state: 'working',
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
  selection?: { selected: readonly Worktree[] }
): HTMLElement {
  return render(
    <ConfirmationDialogContext.Provider value={declineConfirm}>
      <TooltipProvider>
        <WorktreeCard
          worktree={worktree}
          repo={TEST_REPO}
          isActive
          nativeDragEnabled={false}
          isMultiSelected={selection !== undefined}
          selectedWorktrees={selection?.selected}
          onContextMenuSelect={selection ? () => selection.selected : undefined}
        />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  ).container
}

/** Opens the card's menu from `target` and returns its item labels, after showing that it opened. */
function openMenuOn(target: Element): string[] {
  act(() => {
    fireEvent.contextMenu(target)
  })
  const menu = screen.getByRole('menu')
  expect(menu.isConnected).toBe(true)
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? ''
  )
}

function separatorCount(): number {
  return screen.getByRole('menu').querySelectorAll('[role="separator"]').length
}

function closeMenu(): void {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })
  expect(screen.queryByRole('menu')).toBeNull()
}

function deleteItems(labels: string[]): string[] {
  return labels.filter((label) => DELETE_GROUP_LABELS.some((entry) => label.startsWith(entry)))
}

function surfaceOf(container: HTMLElement): Element {
  const surface = container.querySelector('[data-worktree-card-surface]')
  if (!surface) {
    throw new Error('no card surface')
  }
  return surface
}

function agentRows(container: HTMLElement): { root: Element; child: Element } {
  const rows = Array.from(container.querySelectorAll(`[${WORKSPACE_AGENT_ROW_ATTR}]`))
  const child = container.querySelector(
    `.worktree-agent-lineage-child-row[${WORKSPACE_AGENT_ROW_ATTR}]`
  )
  const root = rows.find((row) => row !== child)
  if (!root || !child) {
    throw new Error('expected a root agent row and its worker’s child row')
  }
  return { root, child }
}

afterEach(() => {
  cleanup()
  clearWorktreeAgentExpansionStateForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe.each(['compact', 'full'] as const)('a %s agent row in a workspace card', (mode) => {
  it('opens the workspace menu without Delete, which the card header still offers', () => {
    const container = renderCard(seed(mode))
    expect(deleteItems(openMenuOn(surfaceOf(container)))).toEqual([
      expect.stringMatching(/^Delete/)
    ])
    const headerSeparators = separatorCount()
    closeMenu()
    const { root, child } = agentRows(container)
    for (const row of [root, child]) {
      const labels = openMenuOn(row)
      expect(labels).toContain('Mute Notifications')
      expect(deleteItems(labels)).toEqual([])
      // Delete's group goes with its separator.
      expect(separatorCount()).toBe(headerSeparators - 1)
      closeMenu()
    }
  })

  it('treats anything inside the row as the row', () => {
    const container = renderCard(seed(mode))
    const inner = agentRows(container).root.querySelector('button, [tabindex], span')
    expect(inner).toBeTruthy()
    const labels = openMenuOn(inner!)
    expect(labels).toContain('Mute Notifications')
    expect(deleteItems(labels)).toEqual([])
  })

  it('offers no project removal from an agent row of a primary checkout', () => {
    const container = renderCard(seed(mode, { isMainWorktree: true }))
    expect(deleteItems(openMenuOn(surfaceOf(container)))).toEqual(
      expect.arrayContaining(['Delete Worktree', 'Remove Project from Orca'])
    )
    closeMenu()
    const labels = openMenuOn(agentRows(container).root)
    expect(labels).toContain('Mute Notifications')
    expect(deleteItems(labels)).toEqual([])
  })

  it('offers no batch Delete from an agent row of a multi-selected card', () => {
    const worktree = seed(mode)
    const other = makeWorktree({
      id: `${TEST_REPO.id}::/discount`,
      repoId: TEST_REPO.id,
      path: '/discount',
      displayName: 'discount'
    })
    useAppStore.setState({ worktreesByRepo: { [TEST_REPO.id]: [worktree, other] } })
    const container = renderCard(worktree, { selected: [worktree, other] })
    const header = openMenuOn(surfaceOf(container))
    expect(deleteItems(header)).toEqual([expect.stringMatching(/^Delete 2 Workspaces/)])
    const batchDelete = screen
      .getAllByRole('menuitem')
      .find((item) => item.textContent?.startsWith('Delete 2 Workspaces'))
    expect(batchDelete?.hasAttribute('data-disabled')).toBe(false)
    closeMenu()
    const row = openMenuOn(agentRows(container).root)
    // Still the two-workspace menu (only a multi-selection offers this), with no way to delete either.
    expect(row).toContain('Move Statuses To')
    expect(deleteItems(row)).toEqual([])
  })
})
