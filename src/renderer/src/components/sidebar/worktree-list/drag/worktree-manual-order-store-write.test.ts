// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { makeFolderWorkspace } from '../../../../store/folder-workspaces/folder-workspace.test-fixture'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'
import { useWorktreeStatusMutations } from './use-status-mutations'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

const toastInfo = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { info: toastInfo, dismiss: vi.fn() } }))

/** Run the real metadata action so a drag payload-shape mismatch cannot hide behind an E2E fake. */

const initialState = useAppStore.getInitialState()
const REPO_ID = 'repo-manual-order'
const GROUP_KEY = `repo:${REPO_ID}`

const updateMeta = vi.fn().mockResolvedValue(undefined)

function seedManualOrderedRows(count: number): Worktree[] {
  const worktrees = Array.from({ length: count }, (_, index) =>
    // The store routes a metadata write by the repo id embedded in the worktree id.
    makeWorktree(`${REPO_ID}::manual-${String(index).padStart(2, '0')}`, `Manual ${index}`, {
      repoId: REPO_ID,
      manualOrder: 100_000 - index
    })
  )
  useAppStore.setState({
    sortBy: 'smart',
    worktreesByRepo: { [REPO_ID]: worktrees }
  })
  return worktrees
}

function renderReorder(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[] = []
) {
  return renderHook(() =>
    useWorktreeStatusMutations({
      manualOrderCatalog: buildWorktreeManualOrderCatalog({
        worktrees,
        folderWorkspaces
      }),
      workspaceStatuses: [],
      sortBy: 'smart'
    })
  ).result
}

function manualOrderedIds(): readonly string[] {
  return buildWorktreeManualOrderCatalog({
    worktrees: useAppStore.getState().worktreesByRepo[REPO_ID] ?? [],
    folderWorkspaces: []
  }).orderedKeys.map(getWorktreeIdFromHostIdentity)
}

describe('sidebar manual-order drop', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    updateMeta.mockClear()
    toastInfo.mockClear()
    Object.assign(window, { api: { worktrees: { updateMeta } } })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('moves the dragged row past its neighbor in the store', async () => {
    const worktrees = seedManualOrderedRows(3)
    const ids = worktrees.map((worktree) => worktree.id)
    const keys = worktrees.map(getWorktreeHostIdentity)
    const reorder = renderReorder(worktrees)

    await act(async () => {
      reorder.current.reorderWorktrees({
        groups: [{ key: GROUP_KEY, worktreeIds: keys }],
        sourceGroupKey: GROUP_KEY,
        draggedKeys: [keys[0]!],
        dropIndex: 2
      })
    })

    expect(manualOrderedIds()).toEqual([ids[1], ids[0], ids[2]])
    expect(useAppStore.getState().sortBy).toBe('manual')
    expect(toastInfo).toHaveBeenCalledTimes(1)
    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: ids[0],
      executionHostId: 'local',
      updates: { manualOrder: expect.any(Number) }
    })
  })

  it('does not route a remote folder workspace drop to this computer', async () => {
    const folders = [
      makeFolderWorkspace({ id: 'fw-a', manualOrder: 3000, executionHostId: 'ssh:remote-box' }),
      makeFolderWorkspace({ id: 'fw-b', manualOrder: 2000, executionHostId: 'ssh:remote-box' })
    ]
    const updateFolderWorkspace = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ folderWorkspaces: folders, updateFolderWorkspace })
    const keys = folders.map(getFolderWorkspaceHostIdentity)
    const reorder = renderReorder([], folders)

    await act(async () => {
      reorder.current.reorderWorktrees({
        groups: [{ key: GROUP_KEY, worktreeIds: keys }],
        sourceGroupKey: GROUP_KEY,
        draggedKeys: [keys[0]!],
        dropIndex: 2
      })
    })

    // The save goes to the folder's own host, not 'local'.
    expect(updateFolderWorkspace).toHaveBeenCalledWith(
      'fw-a',
      { manualOrder: expect.any(Number) },
      { executionHostId: 'ssh:remote-box' }
    )
    const folderOrder = buildWorktreeManualOrderCatalog({
      worktrees: [],
      folderWorkspaces: useAppStore.getState().folderWorkspaces
    }).orderedKeys
    expect(folderOrder).toEqual([keys[1], keys[0]])
  })
})
