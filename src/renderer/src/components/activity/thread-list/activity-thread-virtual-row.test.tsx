// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { ActivityThreadVirtualRow } from './activity-thread-virtual-row'

const worktree = makeWorktree({ id: 'workspace', repoId: 'repo' })
const thread: AgentPaneThread = {
  paneKey: 'terminal:first-leaf',
  paneTitle: 'Inspect activity',
  worktree,
  repo: null,
  tab: makeTab({ id: 'terminal', worktreeId: worktree.id, title: 'Activity tab' }),
  agentType: 'codex',
  currentAgentState: null,
  currentAgentEntry: null,
  responsePreview: '',
  latestTimestamp: 1,
  latestEvent: null,
  events: [],
  unread: false
}

const noAction = () => {}
const workspaceRemoval = /\b(delete|remove)\b/i

afterEach(cleanup)

it.each(['single', 'bulk'])('keeps workspace removal out of the %s Activity row menu', (mode) => {
  const targets =
    mode === 'bulk' ? [thread, { ...thread, paneKey: 'terminal:second-leaf' }] : [thread]
  render(
    <ActivityThreadVirtualRow
      item={{ type: 'thread', thread, groupKey: 'all' }}
      projectLabelsByRepoHost={new Map()}
      collapsed={false}
      onToggleGroup={noAction}
      selectedPaneKey={null}
      multiSelectedKeys={new Set(mode === 'bulk' ? targets.map((target) => target.paneKey) : [])}
      onSelectThread={noAction}
      onOpenThread={noAction}
      getContextMenuTargets={() => targets}
      onJumpToWorkspace={noAction}
      onMarkThreadRead={noAction}
      onMarkThreadUnread={noAction}
      onMarkThreadsRead={noAction}
      onMarkThreadsUnread={noAction}
      canJumpToWorkspace={() => true}
      canMarkThreadUnread={() => true}
      compactMode={false}
      showJumpAction
      groupBy="none"
    />,
    { wrapper: TooltipProvider }
  )

  const row = screen.getByRole('listitem')
  expect(within(row).queryByRole('button', { name: workspaceRemoval })).toBeNull()
  fireEvent.contextMenu(row, { button: 2, clientX: 25, clientY: 15 })
  expect(
    within(screen.getByRole('menu')).queryByRole('menuitem', { name: workspaceRemoval })
  ).toBeNull()
})
