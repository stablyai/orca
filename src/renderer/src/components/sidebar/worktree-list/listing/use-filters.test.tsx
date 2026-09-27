// @vitest-environment happy-dom
import { renderHook, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { useSidebarWorktreeFilters } from './use-filters'

const store = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(store.getState()),
    {
      getState: store.getState
    }
  )
}))

afterEach(cleanup)

const local: FolderWorkspace = {
  id: 'same-folder',
  projectGroupId: 'local-group',
  executionHostId: 'local',
  name: 'Local',
  folderPath: '/local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}
const remote: FolderWorkspace = {
  ...local,
  projectGroupId: 'remote-group',
  executionHostId: 'ssh:box',
  connectionId: 'box'
}

describe('revealing folder host filters', () => {
  it.each([
    { target: remote, folders: [local, remote], visible: 'local', expected: 'ssh:box' },
    { target: local, folders: [remote, local], visible: 'ssh:box', expected: 'local' }
  ])(
    'preserves the explicit $expected host despite a same-ID folder first',
    ({ target, folders, visible, expected }) => {
      const setVisibleWorkspaceHostIds = vi.fn()
      store.getState.mockReturnValue({
        repos: [],
        settings: null,
        folderWorkspaces: folders,
        projectGroups: [],
        visibleWorkspaceHostIds: [visible],
        workspaceHostScope: 'all',
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        setVisibleWorkspaceHostIds
      })
      const { result } = renderHook(() => useSidebarWorktreeFilters())
      result.current.revealWorkspaceFilters(folderWorkspaceToWorktree(target))
      expect(setVisibleWorkspaceHostIds).toHaveBeenCalledExactlyOnceWith([visible, expected])
    }
  )
})
