import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'

vi.mock('@/store/index', async () => {
  const { createEditorTabsStore } =
    await import('../../../store/slices/editor/editor-slice-test-harness')
  return { useAppStore: createEditorTabsStore() }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const { useAppStore: store } = await import('@/store/index')
const { drawTabsFromMain } = await import('@/store/slices/tabs/tabs-drawn-from-main.test-fixture')
const { openGitGraph } = await import('./git-graph-tab')
const { editorTabWorkspace } = await import('@/store/slices/editor/tabs/workspace-editor-files')

const CHILD = 'repo-1::/repo'
const OTHER_CHILD = 'repo-2::/other'

function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 0 }
}

let main: Awaited<ReturnType<typeof drawTabsFromMain>> | undefined

afterEach(() => main?.close())

async function seedFolder(): Promise<void> {
  store.setState(store.getInitialState(), true)
  store.setState({
    activeWorktreeId: 'folder:F',
    repos: [repo('repo-1', '/repo'), repo('repo-2', '/other')],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: CHILD, repoId: 'repo-1', path: '/repo' })],
      'repo-2': [makeWorktree({ id: OTHER_CHILD, repoId: 'repo-2', path: '/other' })]
    }
  })
  main = await drawTabsFromMain(store)
}

/** Opens the graph, then waits for main's answer and the frame that draws it. */
async function open(...args: Parameters<typeof openGitGraph>): Promise<void> {
  await openGitGraph(...args)
  await main?.settle()
}

it('opens a folder section repo graph in the folder workspace, one tab per repo', async () => {
  await seedFolder()
  await open(CHILD, undefined, 'folder:F')
  await open(OTHER_CHILD, undefined, 'folder:F')
  await open(CHILD, undefined, 'folder:F')

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
  await seedFolder()
  await open(CHILD)
  await open(CHILD, undefined, 'folder:F')

  const state = store.getState()
  expect(state.openFiles.filter((file) => file.mode === 'git-graph')).toHaveLength(1)
  const [childTab] = state.unifiedTabsByWorktree[CHILD]
  const [folderTab] = state.unifiedTabsByWorktree['folder:F']
  expect(folderTab.entityId).toBe(childTab.entityId)
  // The graph view places its commit diffs in the workspace that shows it.
  expect(editorTabWorkspace(state.unifiedTabsByWorktree, folderTab.id)).toBe('folder:F')
  expect(editorTabWorkspace(state.unifiedTabsByWorktree, childTab.id)).toBe(CHILD)
})

it('places a child graph in the split target when the folder does not show it yet', async () => {
  await seedFolder()
  await open(OTHER_CHILD, undefined, 'folder:F')
  await open(CHILD)
  const [sourceGroup] = store.getState().groupsByWorktree['folder:F']
  const splitTarget = vi.fn(
    () => store.getState().createEmptySplitGroup('folder:F', sourceGroup.id, 'right') ?? undefined
  )

  await open(CHILD, splitTarget, 'folder:F')
  await open(CHILD, splitTarget, 'folder:F')

  const state = store.getState()
  const splitGroupId = splitTarget.mock.results[0]?.value
  expect(splitTarget).toHaveBeenCalledTimes(1)
  expect(splitGroupId).toBeDefined()
  expect(
    state.unifiedTabsByWorktree['folder:F'].find((tab) => tab.entityId === `${CHILD}::git-graph`)
  ).toMatchObject({ groupId: splitGroupId })
})
