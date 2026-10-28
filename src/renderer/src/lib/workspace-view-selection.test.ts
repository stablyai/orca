// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeWorktree,
  makeTab,
  makeUnifiedTab,
  makeTabGroup,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { subscribeWorkspaceViewSelection } from './workspace-view-selection'
import { collectWorkspaceViewPanels } from './workspace-view-catalog'

const initial = useAppStore.getInitialState()
let unsubscribe: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(
    {
      ...initial,
      workspaceViews: [],
      activeWorkspaceViewId: null,
      activeView: 'terminal',
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'local',
      repos: [TEST_REPO],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'workspace', repoId: 'repo1', hostId: 'local' })]
      },
      tabsByWorktree: {
        workspace: ['a', 'b'].map((id) =>
          makeTab({ id, worktreeId: 'workspace', ptyId: `pty-${id}` })
        )
      },
      unifiedTabsByWorktree: {
        workspace: ['a', 'b'].map((id) =>
          makeUnifiedTab({ id, worktreeId: 'workspace', groupId: 'group' })
        )
      },
      groupsByWorktree: {
        workspace: [
          makeTabGroup({
            id: 'group',
            worktreeId: 'workspace',
            activeTabId: 'a',
            tabOrder: ['a', 'b']
          })
        ]
      },
      activeGroupIdByWorktree: { workspace: 'group' }
    },
    true
  )
  const state = useAppStore.getState()
  state.createWorkspaceView('Daily')
  for (const panel of collectWorkspaceViewPanels(state)) {
    state.addWorkspaceViewPanel(panel)
  }
  state.setWorkspaceViewFocus(useAppStore.getState().workspaceViews[0].panels[0].id)
  unsubscribe = subscribeWorkspaceViewSelection()
})
afterEach(() => {
  unsubscribe?.()
  useAppStore.setState(initial, true)
  localStorage.clear()
})

it('replaces the focused panel when a normal new-tab command selects a new terminal', () => {
  const before = useAppStore.getState().workspaceViews[0]
  const created = useAppStore.getState().createTab('workspace')
  const state = useAppStore.getState()
  expect(state.getActiveTab('workspace')?.entityId).toBe(created.id)
  expect(state.workspaceViews[0].panels).toHaveLength(2)
  expect(state.workspaceViews[0].panels[0]).toMatchObject({
    id: before.panels[0].id,
    tabId: state.getActiveTab('workspace')?.id
  })
  expect(state.workspaceViews[0].panels[1]).toEqual(before.panels[1])
  expect(
    state.tabsByWorktree.workspace.some((tab) => tab.id === 'a' && tab.ptyId === 'pty-a')
  ).toBe(true)
})

it('focuses an existing visible panel instead of displaying the same terminal twice', () => {
  const before = useAppStore.getState().workspaceViews[0]
  useAppStore.getState().activateTab('b', { worktreeId: 'workspace' })
  expect(useAppStore.getState().workspaceViews[0].panels).toBe(before.panels)
  expect(useAppStore.getState().workspaceViews[0].focusedPanelId).toBe(before.panels[1].id)
})

it('does not rearrange a view when a terminal is created in the background', () => {
  const before = useAppStore.getState().workspaceViews[0]
  useAppStore.getState().createTab('workspace', undefined, undefined, { activate: false })
  expect(useAppStore.getState().workspaceViews[0]).toBe(before)
})
