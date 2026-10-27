// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useWorkspaceKanbanWorktreeActions } from './use-workspace-kanban-worktree-actions'
import { useWorktreeStatusMutations } from './worktree-list/drag/use-status-mutations'

const local = makeWorktree({ id: 'repo::/local', repoId: 'repo', path: '/local' })
const hosted = makeWorktree({
  id: 'repo::/hosted',
  repoId: 'repo',
  path: '/hosted',
  hostId: toRuntimeExecutionHostId('env-1')
})
const catalog = { orderedIds: [local.id, hosted.id], rankByWorktreeId: new Map<string, number>() }

let updateWorktreesMeta: ReturnType<typeof vi.fn<AppState['updateWorktreesMeta']>>

beforeEach(() => {
  updateWorktreesMeta = vi.fn<AppState['updateWorktreesMeta']>(() => Promise.resolve())
  useAppStore.setState({
    worktreesByRepo: { repo: [local, hosted] },
    folderWorkspaces: [],
    workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
    hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: 'Today' }] },
    removedRuntimeEnvironmentIds: new Set(),
    updateWorktreesMeta,
    recordFeatureInteraction: vi.fn()
  })
})

afterEach(cleanup)

describe("drops into a paired host's own column", () => {
  it('board: moves only the host card and leaves the local card unranked', () => {
    const { result } = renderHook(() =>
      useWorkspaceKanbanWorktreeActions({
        boardDragGroups: [],
        laneFullWorktreeIds: new Map(),
        laneViews: new Map(),
        maybeSyncTaskStatuses: vi.fn(),
        sortBy: 'manual',
        updateWorktreeMeta: vi.fn(),
        updateWorktreesMeta,
        workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
        worktreeById: new Map([
          [local.id, local],
          [hosted.id, hosted]
        ]),
        manualOrderCatalog: catalog,
        worktreesByStatus: new Map()
      })
    )

    result.current.dropWorktreesAtEndOfStatus([local.id], 'status-6')
    expect(updateWorktreesMeta).not.toHaveBeenCalled()

    result.current.dropWorktreesAtEndOfStatus([local.id, hosted.id], 'status-6')
    expect(updateWorktreesMeta.mock.calls[0]?.[0].map((entry) => entry.worktreeId)).toEqual([
      hosted.id
    ])
  })

  it('sidebar: ignores a local card dropped into the host-only group', () => {
    const { result } = renderHook(() =>
      useWorktreeStatusMutations({
        manualOrderCatalog: catalog,
        workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
        sortBy: 'manual'
      })
    )

    result.current.moveWorktreesToStatusAtIndex({
      worktreeIds: [local.id],
      status: 'status-6',
      dropIndex: 0,
      groups: []
    })

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
  })
})
