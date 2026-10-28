import { afterEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeWorktree,
  TEST_REPO,
  makeUnifiedTab,
  makeTabGroup
} from '../store/slices/store-test-helpers'
import { makeFolderWorkspace } from '../store/slices/worktrees-slice-test-fixtures'
import { collectWorkspaceViewPanels, resolveWorkspaceViewTab } from './workspace-view-catalog'

afterEach(() => vi.unstubAllGlobals())
function seed() {
  const store = createTestStore()
  const tab = makeUnifiedTab({ id: 'tab', worktreeId: 'wt', groupId: 'group' })
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: 'wt', repoId: 'repo1', hostId: 'local' })] },
    unifiedTabsByWorktree: { wt: [tab] },
    groupsByWorktree: { wt: [makeTabGroup({ id: 'group', worktreeId: 'wt', tabOrder: ['tab'] })] }
  })
  return { store, tab }
}
it('offers the exact open tabs and refuses a stale or differently owned saved reference', () => {
  const { store, tab } = seed()
  const panels = collectWorkspaceViewPanels(store.getState())
  expect(panels.map((p) => p.tabId)).toEqual(['tab'])
  expect(resolveWorkspaceViewTab(store.getState(), panels[0])).toBe(tab)
  expect(
    resolveWorkspaceViewTab(store.getState(), { ...panels[0], executionHostId: 'ssh:remote' })
  ).toBeNull()
  store.setState({ unifiedTabsByWorktree: { wt: [] } })
  expect(resolveWorkspaceViewTab(store.getState(), panels[0])).toBeNull()
})
it('refuses an unstamped terminal when two hosts share a workspace id', () => {
  const { store } = seed()
  store.setState({
    worktreesByRepo: {
      repo1: [makeWorktree({ id: 'wt', repoId: 'repo1', hostId: 'local' })],
      remote: [makeWorktree({ id: 'wt', repoId: 'remote', hostId: 'ssh:remote' })]
    }
  })
  expect(collectWorkspaceViewPanels(store.getState())).toEqual([])
})
it('includes folder workspaces without assuming a git branch or repository', () => {
  const { store } = seed()
  const folder = makeFolderWorkspace({ executionHostId: 'local' })
  const id = `folder:${folder.id}`
  store.setState({
    folderWorkspaces: [folder],
    unifiedTabsByWorktree: {
      [id]: [makeUnifiedTab({ id: 'folder-tab', worktreeId: id, groupId: 'folder-group' })]
    },
    groupsByWorktree: {
      [id]: [makeTabGroup({ id: 'folder-group', worktreeId: id, tabOrder: ['folder-tab'] })]
    }
  })
  expect(collectWorkspaceViewPanels(store.getState())).toEqual([
    expect.objectContaining({ workspaceId: id, tabId: 'folder-tab', executionHostId: 'local' })
  ])
})
