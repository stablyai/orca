// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { useWorkspaceKanbanWorktreeActions } from './use-workspace-kanban-worktree-actions'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'
import { buildUnambiguousWorktreeIdIndex } from './worktree-unambiguous-id-index'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), dismiss: vi.fn() } }))

// Same repo id and path on two machines: one worktree id, two cards.
const TWIN_ID = 'repo::/home/dev/app'
const onVmA = makeWorktree({
  id: TWIN_ID,
  repoId: 'repo',
  path: '/home/dev/app',
  hostId: 'ssh:vm-a',
  workspaceStatus: 'todo',
  manualOrder: 300
})
const other = makeWorktree({
  id: 'repo::/home/dev/other',
  repoId: 'repo',
  path: '/home/dev/other',
  hostId: 'ssh:vm-a',
  workspaceStatus: 'todo',
  manualOrder: 200
})
const onVmB = { ...onVmA, hostId: 'ssh:vm-b' as const, manualOrder: 100 }
const lane: Worktree[] = [onVmA, other, onVmB]
const keyOf = getWorktreeHostIdentity

let updateWorktreesMeta: ReturnType<typeof vi.fn<AppState['updateWorktreesMeta']>>
const maybeSyncTaskStatuses = vi.fn()

beforeEach(() => {
  updateWorktreesMeta = vi.fn<AppState['updateWorktreesMeta']>(() => Promise.resolve())
  maybeSyncTaskStatuses.mockClear()
  useAppStore.setState({
    sortBy: 'manual',
    worktreesByRepo: { repo: lane },
    folderWorkspaces: [],
    workspaceStatuses: [
      { id: 'todo', label: 'Todo' },
      { id: 'done', label: 'Done' }
    ],
    updateWorktreesMeta,
    recordFeatureInteraction: vi.fn()
  })
})

afterEach(cleanup)

function renderBoardActions() {
  return renderHook(() =>
    useWorkspaceKanbanWorktreeActions({
      boardDragGroups: [
        { key: 'todo', worktreeIds: lane.map(keyOf) },
        { key: 'done', worktreeIds: [] }
      ],
      laneFullWorktreeIds: new Map([
        ['todo', lane.map(keyOf)],
        ['done', []]
      ]),
      laneViews: new Map([
        ['todo', { items: lane }],
        ['done', { items: [] }]
      ]),
      maybeSyncTaskStatuses,
      sortBy: 'manual',
      updateWorktreeMeta: vi.fn(),
      updateWorktreesMeta,
      workspaceStatuses: [
        { id: 'todo', label: 'Todo' },
        { id: 'done', label: 'Done' }
      ],
      worktreeById: buildUnambiguousWorktreeIdIndex(lane),
      worktreeByKey: new Map(lane.map((row) => [keyOf(row), row])),
      manualOrderCatalog: buildWorktreeManualOrderCatalog({
        worktrees: lane,
        folderWorkspaces: []
      }),
      worktreesByStatus: new Map([
        ['todo', lane],
        ['done', []]
      ])
    })
  ).result
}

describe('board drops on one copy of a same-id pair', () => {
  it('reorders only the dragged copy within its lane', () => {
    const actions = renderBoardActions()

    actions.current.dropPointerDraggedWorktreesInStatus({
      worktreeKeys: [keyOf(onVmB)],
      status: 'todo',
      dropIndex: 0
    })

    const writes = updateWorktreesMeta.mock.calls[0]?.[0] ?? []
    expect(writes).toEqual([
      {
        worktreeId: TWIN_ID,
        updates: { manualOrder: expect.any(Number) },
        executionHostId: 'ssh:vm-b'
      }
    ])
    expect(writes[0]!.updates.manualOrder).toBeGreaterThan(300)
  })

  it('moves only the dragged copy to another lane and syncs only its task', () => {
    const actions = renderBoardActions()

    actions.current.dropPointerDraggedWorktreesInStatus({
      worktreeKeys: [keyOf(onVmA)],
      status: 'done',
      dropIndex: 0
    })

    const writes = updateWorktreesMeta.mock.calls[0]?.[0] ?? []
    expect(writes.map((entry) => [entry.executionHostId, entry.updates.workspaceStatus])).toEqual([
      ['ssh:vm-a', 'done']
    ])
    expect(maybeSyncTaskStatuses).toHaveBeenCalledWith([keyOf(onVmA)], 'done')
  })

  it('still refuses a bare-id drop that cannot name one copy', () => {
    const actions = renderBoardActions()

    actions.current.dropWorktreesAtEndOfStatus([TWIN_ID], 'done')

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
  })
})
