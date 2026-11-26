import { expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'

vi.mock('@/store/index', async () => {
  const { createEditorTabsStore } =
    await import('../../../store/slices/editor/editor-slice-test-harness')
  return { useAppStore: createEditorTabsStore() }
})

const { useAppStore: store } = await import('@/store/index')
const { openGitGraph } = await import('./git-graph-tab')
const { editorTabWorkspace } = await import('@/store/slices/editor/tabs/workspace-editor-files')

const CHILD = 'repo-1::/repo'
const OTHER_CHILD = 'repo-2::/other'

function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 0 }
}

function seedFolder(): void {
  store.setState(store.getInitialState(), true)
  store.setState({
    activeWorktreeId: 'folder:F',
    repos: [repo('repo-1', '/repo'), repo('repo-2', '/other')],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: CHILD, repoId: 'repo-1', path: '/repo' })],
      'repo-2': [makeWorktree({ id: OTHER_CHILD, repoId: 'repo-2', path: '/other' })]
    }
  })
}

it('opens a folder section repo graph in the folder workspace, one tab per repo', async () => {
  seedFolder()
  await openGitGraph(CHILD, undefined, 'folder:F')
  await openGitGraph(OTHER_CHILD, undefined, 'folder:F')
  await openGitGraph(CHILD, undefined, 'folder:F')

  const state = store.getState()
  expect(state.unifiedTabsByWorktree[CHILD] ?? []).toEqual([])
  expect(state.unifiedTabsByWorktree['folder:F'].map((tab) => tab.entityId)).toEqual([
    `${CHILD}::git-graph`,
    `${OTHER_CHILD}::git-graph`
  ])
  const [group] = state.groupsByWorktree['folder:F']
  expect(
    state.unifiedTabsByWorktree['folder:F'].find((tab) => tab.id === group.activeTabId)
  ).toMatchObject({ entityId: `${CHILD}::git-graph` })
})

it('shows a graph already open in the child as its own tab in the folder', async () => {
  seedFolder()
  await openGitGraph(CHILD)
  await openGitGraph(CHILD, undefined, 'folder:F')

  const state = store.getState()
  expect(state.openFiles.filter((file) => file.mode === 'git-graph')).toHaveLength(1)
  const [childTab] = state.unifiedTabsByWorktree[CHILD]
  const [folderTab] = state.unifiedTabsByWorktree['folder:F']
  expect(folderTab.entityId).toBe(childTab.entityId)
  // The graph view places its commit diffs in the workspace that shows it.
  expect(editorTabWorkspace(state.unifiedTabsByWorktree, folderTab.id)).toBe('folder:F')
  expect(editorTabWorkspace(state.unifiedTabsByWorktree, childTab.id)).toBe(CHILD)
})
