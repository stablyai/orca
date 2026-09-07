// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'
import { useWorktreeStatusMutations } from './worktree-list/drag/use-status-mutations'

/**
 * The sidebar drop only reorders if the payload `reorderWorktrees` builds is the
 * one `updateWorktreesMeta` consumes. The e2e that covered this replaced the store
 * action with a fake, so a payload-shape change (#16691, Map -> batch array) showed
 * up as a red drag spec instead of a red contract. This runs the real action.
 */

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
      worktreeMap: new Map(worktrees.map((worktree) => [worktree.id, worktree])),
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
  }).orderedIds
}

describe('sidebar manual-order drop', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    updateMeta.mockClear()
    Object.assign(window, { api: { worktrees: { updateMeta } } })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('moves the dragged row past its neighbor in the store', async () => {
    const worktrees = seedManualOrderedRows(3)
    const ids = worktrees.map((worktree) => worktree.id)
    const reorder = renderReorder(worktrees)

    await act(async () => {
      reorder.current.reorderWorktrees({
        groups: [{ key: GROUP_KEY, worktreeIds: ids }],
        sourceGroupKey: GROUP_KEY,
        draggedIds: [ids[0]!],
        dropIndex: 2
      })
    })

    expect(manualOrderedIds()).toEqual([ids[1], ids[0], ids[2]])
    expect(useAppStore.getState().sortBy).toBe('manual')
    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: ids[0],
      executionHostId: 'local',
      updates: { manualOrder: expect.any(Number) }
    })
  })

  it('leaves the order alone when the drop lands where the row already is', async () => {
    const worktrees = seedManualOrderedRows(3)
    const ids = worktrees.map((worktree) => worktree.id)
    const reorder = renderReorder(worktrees)
    const epochBeforeDrop = useAppStore.getState().sortEpoch

    await act(async () => {
      reorder.current.reorderWorktrees({
        groups: [{ key: GROUP_KEY, worktreeIds: ids }],
        sourceGroupKey: GROUP_KEY,
        draggedIds: [ids[0]!],
        dropIndex: 1
      })
    })

    expect(manualOrderedIds()).toEqual(ids)
    expect(useAppStore.getState().sortBy).toBe('smart')
    expect(useAppStore.getState().sortEpoch).toBe(epochBeforeDrop)
    expect(updateMeta).not.toHaveBeenCalled()
  })
})
