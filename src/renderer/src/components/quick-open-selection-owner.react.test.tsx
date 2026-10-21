// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { it, expect, afterEach, vi } from 'vitest'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { DetectedWorktree } from '../../../shared/worktree/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useQuickOpenInteraction } from './use-quick-open-interaction'
import {
  captureFileExplorerOperationGuard,
  getFileExplorerOperationOwnerFromState
} from './right-sidebar/file-explorer-operation-owner'
const mocks = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn(() => 'owner-file') }))
vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.stat }))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  scheduleEditorLineReveal: vi.fn()
}))
import { openQuickOpenFile } from './quick-open-file-navigation'
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})
it('revokes a pending actual open when detected ownership changes and returns', async () => {
  const id = 'repo::/repo'
  const local: DetectedWorktree = {
    ...makeWorktree({ id, repoId: 'repo', hostId: 'local' }),
    ownership: 'external',
    selectedCheckout: true,
    visible: true
  }
  useAppStore.setState({
    openFile: mocks.open,
    activeModal: 'quick-open',
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: null,
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      repo: { repoId: 'repo', authoritative: true, source: 'git', worktrees: [local] }
    }
  })
  const before = getFileExplorerOperationOwnerFromState(useAppStore.getState(), id)
  const guard = captureFileExplorerOperationGuard(id, before)
  const hook = renderHook(() => useQuickOpenInteraction(id))
  let assertCurrent = (): void => {
    throw new Error('Interaction not started')
  }
  act(() => {
    assertCurrent = hook.result.current.begin().assertCurrent
  })
  let release = (): void => {
    throw new Error('Stat not started')
  }
  mocks.stat.mockReturnValue(
    new Promise((resolve) => {
      release = () => resolve({ isDirectory: false, escapesWorktree: false })
    })
  )
  const opening = openQuickOpenFile(
    'file.ts',
    id,
    '/repo',
    { pathQuery: 'file.ts' },
    'file.ts',
    assertCurrent
  )
  act(() => {
    useAppStore.setState({
      detectedWorktreesByRepo: {
        repo: {
          repoId: 'repo',
          authoritative: true,
          source: 'git',
          worktrees: [{ ...local, runtimeOwnerEnvironmentId: 'env-b' }]
        }
      }
    })
  })
  expect(getFileExplorerOperationOwnerFromState(useAppStore.getState(), id)).not.toEqual(before)
  act(() => {
    useAppStore.setState({
      detectedWorktreesByRepo: {
        repo: { repoId: 'repo', authoritative: true, source: 'git', worktrees: [local] }
      }
    })
  })
  expect(() => guard.assertCurrent()).not.toThrow()
  release()
  await expect(opening).rejects.toThrow('selection was cancelled')
  expect(mocks.open).not.toHaveBeenCalled()
})

const folder = {
  id: 'root-folder',
  projectGroupId: 'group',
  name: 'Folder',
  folderPath: '/rootA',
  connectionId: null,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 1,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}
it.each(['root', 'root-return', 'restored-owner'])(
  'revokes a pending actual open on %s change',
  async (change) => {
    const id = folderWorkspaceKey(folder.id)
    useAppStore.setState({
      openFile: mocks.open,
      activeModal: 'quick-open',
      activeWorktreeId: id,
      activeWorkspaceExecutionHostId: null,
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [folder],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {}
    })
    const hook = renderHook(() => useQuickOpenInteraction(id))
    let assertCurrent = (): void => {
      throw new Error('Interaction not started')
    }
    act(() => {
      assertCurrent = hook.result.current.begin().assertCurrent
    })
    let release = (): void => {
      throw new Error('Stat not started')
    }
    mocks.stat.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ isDirectory: false, escapesWorktree: false })
      })
    )
    const opening = openQuickOpenFile(
      'file.ts',
      id,
      '/rootA',
      { pathQuery: 'file.ts' },
      'file.ts',
      assertCurrent
    )
    act(() => {
      if (change === 'restored-owner') {
        useAppStore.setState({
          restoredRuntimeHostIdByWorkspaceSessionKey: { [id]: 'runtime:env-b' }
        })
        expect(getFileExplorerOperationOwnerFromState(useAppStore.getState(), id)).toMatchObject({
          kind: 'runtime'
        })
        useAppStore.setState({ restoredRuntimeHostIdByWorkspaceSessionKey: {} })
      } else {
        useAppStore.setState({ folderWorkspaces: [{ ...folder, folderPath: '/rootB' }] })
        expect(useAppStore.getState().getKnownWorktreeById(id)?.path).toBe('/rootB')
        if (change === 'root-return') {
          useAppStore.setState({ folderWorkspaces: [folder] })
        }
      }
    })
    release()
    await expect(opening).rejects.toThrow('selection was cancelled')
    expect(mocks.open).not.toHaveBeenCalled()
  }
)
