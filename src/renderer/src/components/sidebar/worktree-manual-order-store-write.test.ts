// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'
import { useWorktreeStatusMutations } from './worktree-list/drag/use-status-mutations'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'

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

function renderReorder(worktrees: readonly Worktree[]) {
  return renderHook(() =>
    useWorktreeStatusMutations({
      manualOrderCatalog: buildWorktreeManualOrderCatalog({
        worktrees,
        folderWorkspaces: []
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

  it('leaves the order alone when the drop lands where the row already is', async () => {
    const worktrees = seedManualOrderedRows(3)
    const ids = worktrees.map((worktree) => worktree.id)
    const keys = worktrees.map(getWorktreeHostIdentity)
    const reorder = renderReorder(worktrees)
    const epochBeforeDrop = useAppStore.getState().sortEpoch

    await act(async () => {
      reorder.current.reorderWorktrees({
        groups: [{ key: GROUP_KEY, worktreeIds: keys }],
        sourceGroupKey: GROUP_KEY,
        draggedKeys: [keys[0]!],
        dropIndex: 1
      })
    })

    expect(manualOrderedIds()).toEqual(ids)
    expect(useAppStore.getState().sortBy).toBe('smart')
    expect(useAppStore.getState().sortEpoch).toBe(epochBeforeDrop)
    expect(updateMeta).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('reorders silently when Manual is already the sort', async () => {
    const worktrees = seedManualOrderedRows(3)
    useAppStore.setState({ sortBy: 'manual' })
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
    expect(toastInfo).not.toHaveBeenCalled()
  })
})
