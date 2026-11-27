// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  clearWorktreeAgentExpansionStateForTests,
  seedWorktreeAgentExpansionStateForTests
} from '../activity/worktree-card-agents-expansion-state'
import WorktreeCard from './WorktreeCard'

const declineConfirmation = async (): Promise<boolean> => false

afterEach(() => {
  cleanup()
  clearWorktreeAgentExpansionStateForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderAgentCard(mode: 'compact' | 'full') {
  const worktree = makeWorktree({ id: `${TEST_REPO.id}::/sample`, repoId: TEST_REPO.id })
  const tab: Tab = {
    id: 'agent-tab',
    entityId: '11111111-1111-4111-8111-111111111111',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    worktreeId: worktree.id,
    groupId: 'group',
    executionHostId: 'local',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  seedWorktreeAgentExpansionStateForTests(worktree.id, {
    expandedLineageParents: new Set(),
    expandedIdleChildGroups: new Set(),
    compactRootListExpanded: true
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    agentActivityDisplayMode: mode,
    unifiedTabsByWorktree: { [worktree.id]: [tab] },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [
        paneKey,
        {
          paneKey,
          worktreeId: worktree.id,
          agentType: 'codex',
          state: 'working',
          prompt: 'Draft a checklist',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: []
        }
      ]
    ])
  })
  const { container } = render(
    <ConfirmationDialogContext.Provider value={declineConfirmation}>
      <TooltipProvider>
        <WorktreeCard worktree={worktree} repo={TEST_REPO} isActive nativeDragEnabled={false} />
      </TooltipProvider>
    </ConfirmationDialogContext.Provider>
  )
  return { container, worktree }
}

it.each(['compact', 'full'] as const)(
  'keeps Delete and its shortcut on the card header after opening the menu from a %s agent row',
  async (mode) => {
    const { container } = renderAgentCard(mode)
    const agentRowChild = container.querySelector('.agent-disclosure-row span')
    expect(agentRowChild).not.toBeNull()
    fireEvent.contextMenu(agentRowChild!)
    const rowMenu = within(await screen.findByRole('menu'))
    expect(
      rowMenu.queryByRole('menuitem', { name: /^(Delet|Remove (Workspace|Project))/ })
    ).toBeNull()
    const rowSeparators = rowMenu.getAllByRole('separator').length
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    const title = container.querySelector('[data-worktree-title-inline-rename]')
    expect(title).not.toBeNull()
    fireEvent.contextMenu(title!)
    const headerMenu = within(await screen.findByRole('menu'))
    const deleteItem = headerMenu.getByRole('menuitem', { name: /^Delete/ })
    expect(deleteItem.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toMatch(
      /^(⌘⇧⌫|Ctrl\+⇧\+Backspace)$/
    )
    expect(headerMenu.getAllByRole('separator')).toHaveLength(rowSeparators + 1)
  }
)

it.each(['compact', 'full'] as const)(
  'prevents the %s agent row mousedown default only while it is a send target',
  (mode) => {
    const { container, worktree } = renderAgentCard(mode)
    const row = container.querySelector('[data-workspace-agent-row]')
    expect(row).not.toBeNull()
    expect(fireEvent.mouseDown(row!)).toBe(true)

    act(() =>
      useAppStore.getState().openAgentSendPopoverTargetMode({
        id: 'notes',
        worktreeId: worktree.id,
        source: 'diff-notes',
        prompt: 'Review notes',
        label: 'Notes',
        launchSource: 'notes_send'
      })
    )
    expect(row!.hasAttribute('data-agent-send-target')).toBe(true)
    expect(fireEvent.mouseDown(row!)).toBe(false)
  }
)
