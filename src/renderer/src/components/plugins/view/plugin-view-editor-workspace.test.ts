// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { showWorkspaceForFile } from './plugin-view-editor-workspace'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

const activation = vi.hoisted(() => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => activation)
const initialState = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
})

it('refuses a retired file owner without registering its deleting directory as a folder', async () => {
  const addRepoPath = vi.fn()
  const row = makeWorktree({
    id: 'r::/work/feature',
    repoId: 'r',
    path: '/work/feature',
    hostId: 'local',
    removing: true,
    removalRecorded: true
  })
  useAppStore.setState({
    worktreesByRepo: { r: [row] },
    folderWorkspaces: [],
    activeWorktreeId: null,
    addRepoPath
  })
  await expect(
    showWorkspaceForFile(['/work/feature/document.ext'], '/work/feature')
  ).resolves.toBeNull()
  expect(addRepoPath).not.toHaveBeenCalled()
  expect(activation.activateAndRevealWorkspace).not.toHaveBeenCalled()

  useAppStore.setState({ worktreesByRepo: { r: [{ ...row, removalRecorded: undefined }] } })
  await expect(
    showWorkspaceForFile(['/work/feature/document.ext'], '/work/feature')
  ).resolves.toMatchObject({ worktreeId: row.id })
  expect(addRepoPath).not.toHaveBeenCalled()
  expect(activation.activateAndRevealWorkspace).toHaveBeenCalledWith(row.id, {
    providesInitialSurface: true,
    executionHostId: 'local'
  })
})

it('still registers a genuinely unowned file folder and opens it', async () => {
  const row = makeWorktree({
    id: 'added::/new/folder',
    repoId: 'added',
    path: '/new/folder',
    hostId: 'local'
  })
  const addRepoPath = vi.fn<typeof initialState.addRepoPath>(async () => {
    useAppStore.setState({ worktreesByRepo: { added: [row] } })
    return {
      id: 'added',
      path: '/new/folder',
      displayName: 'added',
      badgeColor: 'blue',
      addedAt: 1
    }
  })
  const fetchWorktrees = vi.fn().mockResolvedValue(true)
  useAppStore.setState({
    worktreesByRepo: {},
    folderWorkspaces: [],
    activeWorktreeId: null,
    addRepoPath,
    fetchWorktrees
  })
  await expect(
    showWorkspaceForFile(['/new/folder/document.ext'], '/new/folder')
  ).resolves.toMatchObject({ worktreeId: row.id, addedRepoId: 'added' })
  expect(addRepoPath).toHaveBeenCalledWith('/new/folder', 'folder', { runtimeEnvironmentId: null })
  expect(fetchWorktrees).toHaveBeenCalledWith('added')
  expect(activation.activateAndRevealWorkspace).toHaveBeenCalledWith(row.id, {
    providesInitialSurface: true,
    executionHostId: 'local'
  })
})
