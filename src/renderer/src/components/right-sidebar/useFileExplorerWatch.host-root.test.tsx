// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { buildEditorExternalWatchEventHandler } from '@/hooks/editor-external-watch-event-reconciliation'
import { selectEditorExternalWatchTargets } from '@/hooks/editor-external-watch-targets'
import { getDefaultSettings } from '../../../../shared/constants'
import { useFileExplorerWatch } from './useFileExplorerWatch'

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector({}), {
    getState: () => ({ openFiles: [] })
  })
}))
vi.mock('./file-explorer-operation-owner', () => {
  const owner = { kind: 'runtime', environmentId: 'host-b', executionHostId: 'runtime:host-b' }
  return {
    getFileExplorerOperationOwner: () => owner,
    getFileExplorerOperationOwnerFromState: () => owner
  }
})
vi.mock('@/runtime/runtime-file-client', () => ({ subscribeRuntimeFileChanges: vi.fn() }))

const refreshDir = vi.fn(async () => {})
const refreshTree = vi.fn(async () => 'refreshed' as const)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { onFsChanged: vi.fn(() => vi.fn()) } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('refreshes the selected host Explorer when another host publishes the same worktree id at a different root', async () => {
  const { targets } = selectEditorExternalWatchTargets({
    settings: getDefaultSettings('/home/me'),
    openFiles: [],
    activeWorktreeId: 'same-worktree',
    activeWorkspaceExecutionHostId: 'runtime:host-b',
    repos: [],
    worktreesByRepo: {
      repo: (['host-a', 'host-b'] as const).map((host) =>
        makeWorktree({
          id: 'same-worktree',
          repoId: 'repo',
          path: `/${host}/repo`,
          hostId: `runtime:${host}`
        })
      )
    },
    folderWorkspaces: [],
    projectGroups: [],
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map()
  })
  const [target] = targets
  const adapter = buildEditorExternalWatchEventHandler((worktreePath, runtimeEnvironmentId) =>
    targets.find(
      (candidate) =>
        candidate.worktreePath === worktreePath &&
        candidate.runtimeEnvironmentId === runtimeEnvironmentId
    )
  )
  renderHook(() =>
    useFileExplorerWatch({
      worktreePath: '/host-b/repo',
      activeWorktreeId: 'same-worktree',
      dirCache: { '/host-b/repo': { children: [] } },
      setDirCache: vi.fn(),
      expanded: new Set(),
      setSelectedPath: vi.fn(),
      refreshDir,
      refreshTree,
      inlineInput: null,
      dragSourcePath: null,
      isNativeDragOver: false
    })
  )
  // The runtime watch client roots each batch at the watched target's path.
  act(() => {
    adapter.handleFsChanged(
      {
        worktreePath: target.worktreePath,
        events: [
          {
            kind: 'create',
            absolutePath: `${target.worktreePath}/new.ts`,
            isDirectory: false
          }
        ]
      },
      target.runtimeEnvironmentId
    )
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  adapter.dispose()
  expect(refreshDir).toHaveBeenCalledExactlyOnceWith('/host-b/repo')
})
