// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useWindowPaneNavigation } from './cross-project-panes/use-window-pane-navigation'
import {
  addPaneProject,
  resetPanePresentation
} from './cross-project-panes/pane-presentation-test-fixture'
import { paneLayoutActions } from './cross-project-panes/workspace-layout-actions'
import { getCmdJQuickActions } from './cmd-j/quick-actions'
import { WindowPaneLayoutSchema } from '../../../shared/window-pane-schema'
import { getDefaultWorkspaceSession } from '../../../shared/constants'

beforeEach(resetPanePresentation)
afterEach(cleanup)

it('honors explicit workspace activation published together with catalog reconciliation', () => {
  addPaneProject('alpha', 'Alpha')
  const beta = addPaneProject('beta', 'Beta')
  const state = useAppStore.getState()
  state.splitWindowPane(state.windowPaneLayout!.activePaneId, 'horizontal')
  const saved = useAppStore.getState().windowPaneLayout!
  state.focusWindowPane(Object.keys(saved.panes).find((id) => id !== saved.activePaneId)!)
  renderHook(useWindowPaneNavigation)
  act(() =>
    useAppStore.setState({
      activeWorktreeId: beta.worktreeId,
      activeWorkspaceExecutionHostId: 'local',
      unifiedTabsByWorktree: { ...useAppStore.getState().unifiedTabsByWorktree }
    })
  )
  const layout = useAppStore.getState().windowPaneLayout!
  expect(layout.views[layout.panes[layout.activePaneId].selectedViewId!].worktreeId).toBe(
    beta.worktreeId
  )
})

it('keeps saved split placements unchanged when a later catalog snapshot republishes its tabs', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  state.createUnifiedTab('alpha-workspace', 'terminal', { executionHostId: 'local' })
  state.synchronizeWindowPaneSelection()
  state.splitWindowPane(useAppStore.getState().windowPaneLayout!.activePaneId, 'horizontal')
  const saved = useAppStore.getState().windowPaneLayout
  renderHook(useWindowPaneNavigation)
  act(() =>
    useAppStore.setState({
      unifiedTabsByWorktree: { ...useAppStore.getState().unifiedTabsByWorktree }
    })
  )
  expect(useAppStore.getState().windowPaneLayout).toEqual(saved)
  act(() => useAppStore.setState({ activeFileId: 'unrelated-restored-editor' }))
  expect(useAppStore.getState().windowPaneLayout).toEqual(saved)
})

it('marks native monitor actions unavailable in browser clients', async () => {
  const actions = getCmdJQuickActions().filter((action) => action.id.includes('monitor'))
  expect(actions).toHaveLength(2)
  for (const action of actions) {
    expect(action.isAvailable({} as never)).toEqual({
      available: false,
      reason: 'client-action-unsupported'
    })
    expect(await action.run({} as never)).toEqual({
      status: 'unavailable',
      reason: 'client-action-unsupported'
    })
  }
})

it('keeps a selected runtime editor view resolved when hydration canonicalizes file identity', () => {
  addPaneProject('alpha', 'Alpha', 'runtime:owner')
  const state = useAppStore.getState()
  const tab = state.createUnifiedTab('alpha-workspace', 'editor', {
    executionHostId: 'runtime:owner',
    entityId: '/draft.md'
  })
  state.synchronizeWindowPaneSelection()
  const before = useAppStore.getState().windowPaneLayout!
  const viewId = before.panes[before.activePaneId].selectedViewId!
  state.hydrateEditorSession({
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: {
      'alpha-workspace': [
        {
          filePath: '/draft.md',
          relativePath: 'draft.md',
          worktreeId: 'alpha-workspace',
          language: 'markdown',
          runtimeEnvironmentId: 'owner',
          dirtyDraftContent: 'unsaved'
        }
      ]
    }
  })
  const restored = useAppStore.getState()
  const editor = restored.openFiles[0]
  expect(editor.id).not.toBe('/draft.md')
  expect(restored.windowPaneLayout!.views[viewId]).toMatchObject({
    id: viewId,
    tabId: tab.id,
    entityId: editor.id,
    executionHostId: 'runtime:owner'
  })
  expect(restored.windowPaneLayout!.panes).toEqual(before.panes)
})

it('presents newly created tabs after initial selection restoration', () => {
  addPaneProject('alpha', 'Alpha')
  renderHook(useWindowPaneNavigation)
  let tab!: ReturnType<typeof useAppStore.getState>['unifiedTabsByWorktree'][string][number]
  act(() => {
    tab = useAppStore
      .getState()
      .createUnifiedTab('alpha-workspace', 'terminal', { executionHostId: 'local', label: 'new' })
  })
  const layout = useAppStore.getState().windowPaneLayout!
  expect(layout.views[layout.panes[layout.activePaneId].selectedViewId!].tabId).toBe(tab.id)
})

it('presents the first late tab in a saved empty pane', () => {
  useAppStore.setState({ activeWorktreeId: 'empty', activeWorkspaceExecutionHostId: 'local' })
  useAppStore.getState().initializeWindowPanes()
  renderHook(useWindowPaneNavigation)
  act(() => {
    useAppStore.getState().createUnifiedTab('empty', 'terminal', { executionHostId: 'local' })
  })
  expect(Object.keys(useAppStore.getState().windowPaneLayout!.views)).toHaveLength(1)
})

it('reopens a pane beside a changed split subtree without losing its later splits', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const first = state.windowPaneLayout!.activePaneId
  state.splitWindowPane(first, 'horizontal')
  const second = useAppStore.getState().windowPaneLayout!.activePaneId
  state.splitWindowPane(second, 'vertical')
  state.closeWindowPane(first)
  state.splitWindowPane(second, 'horizontal')
  const later = useAppStore.getState().windowPaneLayout!.activePaneId
  state.reopenClosedWorkspaceView()
  const layout = useAppStore.getState().windowPaneLayout!
  expect(layout.panes[later]).toBeDefined()
  expect(Object.keys(layout.panes)).toHaveLength(4)
  expect(WindowPaneLayoutSchema.safeParse(layout).success).toBe(true)
})

it('undo preserves an introduced editor view changed after duplication', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  state.createUnifiedTab('alpha-workspace', 'editor', {
    executionHostId: 'local',
    entityId: 'draft'
  })
  state.synchronizeWindowPaneSelection()
  state.openAnotherWorkspaceView(useAppStore.getState().windowPaneLayout!.activePaneId)
  const duplicate = useAppStore.getState().windowPaneLayout!
  const viewId = duplicate.panes[duplicate.activePaneId].selectedViewId!
  useAppStore.setState({ editorDrafts: { draft: 'edited after duplication' } })
  state.undoWorkspaceLayoutChange()
  const layout = useAppStore.getState().windowPaneLayout!
  expect(layout.views[viewId]).toBeDefined()
  expect(Object.values(layout.panes).some((pane) => pane.viewIds.includes(viewId))).toBe(true)
  expect(WindowPaneLayoutSchema.safeParse(layout).success).toBe(true)
})

it('reopening does not reverse a later reorder of surviving tabs', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  state.createUnifiedTab('alpha-workspace', 'terminal', { executionHostId: 'local' })
  state.createUnifiedTab('alpha-workspace', 'terminal', { executionHostId: 'local' })
  state.synchronizeWindowPaneSelection()
  const layout = useAppStore.getState().windowPaneLayout!
  const [a, b, c] = layout.panes[layout.activePaneId].viewIds
  state.closeWorkspaceView(layout.activePaneId, a)
  state.moveWorkspaceView(c, { paneId: layout.activePaneId, zone: 'center', beforeViewId: b })
  state.reopenClosedWorkspaceView()
  expect(useAppStore.getState().windowPaneLayout!.panes[layout.activePaneId].viewIds).toEqual([
    a,
    c,
    b
  ])
})

it('exposes undo and reopen through both the existing layout menu and Jump actions', async () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const paneId = state.windowPaneLayout!.activePaneId
  state.splitWindowPane(paneId, 'horizontal')
  const undo = paneLayoutActions(paneId).find((action) => action.label === 'Undo Layout Change')
  expect(undo).toBeDefined()
  undo!.run()
  expect(useAppStore.getState().windowPaneLayout!.root.type).toBe('leaf')
  const viewId = useAppStore.getState().windowPaneLayout!.panes[paneId].selectedViewId!
  state.closeWorkspaceView(paneId, viewId)
  const reopen = getCmdJQuickActions().find((action) => action.title === 'Reopen Closed View')
  expect(reopen).toBeDefined()
  await reopen!.run({} as never)
  expect(useAppStore.getState().windowPaneLayout!.panes[paneId].viewIds).toContain(viewId)
})

it('automatically projects saved active pane and selection over stale legacy selection', () => {
  const alpha = addPaneProject('alpha', 'Alpha')
  const beta = addPaneProject('beta', 'Beta')
  const state = useAppStore.getState()
  state.splitWindowPane(state.windowPaneLayout!.activePaneId, 'vertical')
  const saved = useAppStore.getState().windowPaneLayout!
  state.expandWindowPane(saved.activePaneId)
  const expanded = useAppStore.getState().windowPaneLayout!
  useAppStore.setState({ activeWorktreeId: alpha.worktreeId, activeTabId: alpha.entityId })
  renderHook(useWindowPaneNavigation)
  expect(useAppStore.getState().activeWorktreeId).toBe(beta.worktreeId)
  expect(useAppStore.getState().activeTabId).toBe(beta.entityId)
  expect(useAppStore.getState().windowPaneLayout).toEqual(expanded)
})

it('retains offline saved ownership and retries projection when its tabs arrive', () => {
  const alpha = addPaneProject('alpha', 'Alpha')
  const beta = addPaneProject('beta', 'Remote folder', 'runtime:offline')
  const saved = useAppStore.getState().windowPaneLayout!
  const tabs = useAppStore.getState().unifiedTabsByWorktree
  useAppStore.setState({
    activeWorktreeId: alpha.worktreeId,
    activeTabId: alpha.entityId,
    unifiedTabsByWorktree: { [alpha.worktreeId]: tabs[alpha.worktreeId] }
  })
  renderHook(useWindowPaneNavigation)
  expect(useAppStore.getState().windowPaneLayout).toEqual(saved)
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:offline')
  expect(useAppStore.getState().activeTabId).toBeNull()
  act(() => useAppStore.setState({ unifiedTabsByWorktree: tabs }))
  expect(useAppStore.getState().activeTabId).toBe(beta.entityId)
  expect(useAppStore.getState().windowPaneLayout).toEqual(saved)
})

it('visiting a pane reveals it when another pane is expanded', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const first = state.windowPaneLayout!.activePaneId
  state.splitWindowPane(first, 'horizontal')
  state.expandWindowPane(useAppStore.getState().windowPaneLayout!.activePaneId)
  state.focusWindowPane(first)
  expect(useAppStore.getState().windowPaneLayout!.expandedPaneId).toBeNull()
})

it('reopens the closed view at its prior position while preserving drafts and later tabs', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  state.createUnifiedTab('alpha-workspace', 'editor', {
    executionHostId: 'local',
    entityId: 'draft'
  })
  state.synchronizeWindowPaneSelection()
  useAppStore.setState({ editorDrafts: { draft: 'unsaved text' } })
  const before = useAppStore.getState().windowPaneLayout!
  const pane = before.panes[before.activePaneId]
  const closed = pane.viewIds[0]
  state.closeWorkspaceView(pane.id, closed)
  const later = state.createUnifiedTab('alpha-workspace', 'terminal', {
    executionHostId: 'local',
    label: 'later'
  })
  state.synchronizeWindowPaneSelection()
  const sessions = useAppStore.getState().unifiedTabsByWorktree
  expect(state).toHaveProperty('reopenClosedWorkspaceView')
  useAppStore.getState().reopenClosedWorkspaceView()
  const after = useAppStore.getState()
  expect(after.windowPaneLayout!.panes[pane.id].viewIds[0]).toBe(closed)
  expect(Object.values(after.windowPaneLayout!.views).some((view) => view.tabId === later.id)).toBe(
    true
  )
  expect(after.editorDrafts).toEqual({ draft: 'unsaved text' })
  expect(after.unifiedTabsByWorktree).toBe(sessions)
  expect(window.api.pty.kill).not.toHaveBeenCalled()
})

it('undoes a split without rolling back later selection, tabs, or editor changes', () => {
  addPaneProject('alpha', 'Alpha')
  const state = useAppStore.getState()
  const before = state.windowPaneLayout!
  state.splitWindowPane(before.activePaneId, 'vertical')
  const later = state.createUnifiedTab('alpha-workspace', 'terminal', {
    executionHostId: 'local',
    label: 'later'
  })
  state.synchronizeWindowPaneSelection()
  useAppStore.setState({ editorDrafts: { draft: 'later typing' } })
  expect(state).toHaveProperty('undoWorkspaceLayoutChange')
  useAppStore.getState().undoWorkspaceLayoutChange()
  const after = useAppStore.getState()
  expect(after.windowPaneLayout!.root).toEqual(before.root)
  expect(Object.keys(after.windowPaneLayout!.panes)).toEqual([before.activePaneId])
  expect(Object.values(after.windowPaneLayout!.views).some((view) => view.tabId === later.id)).toBe(
    true
  )
  expect(after.editorDrafts.draft).toBe('later typing')
  expect(window.api.pty.kill).not.toHaveBeenCalled()
})

it('reopens a closed pane with its ratio and unresolved remote owner', () => {
  addPaneProject('alpha', 'Alpha')
  addPaneProject('beta', 'Remote folder', 'runtime:offline')
  const state = useAppStore.getState()
  state.splitWindowPane(state.windowPaneLayout!.activePaneId, 'horizontal')
  state.setWindowPaneRatio('', 0.35)
  const before = useAppStore.getState().windowPaneLayout!
  state.closeWindowPane(before.activePaneId)
  expect(state).toHaveProperty('reopenClosedWorkspaceView')
  useAppStore.getState().reopenClosedWorkspaceView()
  expect(useAppStore.getState().windowPaneLayout).toEqual(before)
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('runtime:offline')
})
