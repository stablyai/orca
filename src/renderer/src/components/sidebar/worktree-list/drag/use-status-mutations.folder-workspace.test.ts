// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import { switchSortToManualAfterDrop } from '../../manual-sort-switch-toast'
import { useWorktreeStatusMutations } from './use-status-mutations'

const updateWorktreesMeta = vi.fn()
const updateFolderWorkspace = vi.fn()

function makeFolderWorkspace(id: string, connectionId: string | null): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-a',
    name: id,
    folderPath: `/tmp/${id}`,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

const storeState = {
  updateWorktreeMeta: vi.fn(),
  updateWorktreesMeta,
  updateFolderWorkspace,
  setWorktreesPinnedAndReveal: vi.fn(),
  folderWorkspaces: [makeFolderWorkspace('a', 'conn-1'), makeFolderWorkspace('b', 'conn-1')]
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('../../manual-sort-switch-toast', () => ({ switchSortToManualAfterDrop: vi.fn() }))

describe('folder workspace reorder writes', () => {
  it('persists manualOrder through the folder workspace owner and switches to Manual', () => {
    const { result } = renderHook(() =>
      useWorktreeStatusMutations({
        worktreeMap: new Map(),
        manualOrderCatalog: {
          orderedIds: ['folder:a', 'folder:b'],
          rankByWorktreeId: new Map([
            ['folder:a', 2_000],
            ['folder:b', 1_000]
          ])
        },
        workspaceStatuses: [],
        sortBy: 'name'
      })
    )

    result.current.reorderWorktrees({
      groups: [{ key: 'folder-workspaces:x', worktreeIds: ['folder:a', 'folder:b'] }],
      sourceGroupKey: 'folder-workspaces:x',
      draggedIds: ['folder:b'],
      dropIndex: 0
    })

    expect(switchSortToManualAfterDrop).toHaveBeenCalled()
    expect(updateFolderWorkspace).toHaveBeenCalledTimes(1)
    const [folderWorkspaceId, updates, options] = updateFolderWorkspace.mock.calls[0]!
    expect(folderWorkspaceId).toBe('b')
    expect(updates.manualOrder).toBeGreaterThan(2_000)
    // Why: an SSH folder must be written on its own host, not the local fallback.
    expect(options).toEqual({ executionHostId: toSshExecutionHostId('conn-1') })
    expect(updateWorktreesMeta).not.toHaveBeenCalled()
  })
})
