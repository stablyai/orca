// @vitest-environment happy-dom
// Mock only IPC: mocked listing shapes previously hid loss of all local filter results (#21423).

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const cancelRuntimeFileListMock = vi.hoisted(() => vi.fn())
const searchRuntimeFilePathsMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-search-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: cancelRuntimeFileListMock,
  searchRuntimeFilePaths: searchRuntimeFilePathsMock
}))

const initialAppState = useAppStore.getInitialState()
const LOCAL_KEY = folderWorkspaceKey('local-workspace')
const REMOTE_KEY = folderWorkspaceKey('remote-workspace')

function projectGroup(id: string, parentPath: string, connectionId: string | null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath,
    connectionId,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderWorkspace(
  id: string,
  projectGroupId: string,
  folderPath: string,
  connectionId: string | null
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath,
    connectionId,
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
}

function seedWorkspaces(): void {
  const workspaces: Partial<AppState> = {
    folderWorkspaces: [
      folderWorkspace('local-workspace', 'local-group', '/local/proj', null),
      folderWorkspace('remote-workspace', 'remote-group', '/srv/remote', 'ssh-1')
    ],
    projectGroups: [
      projectGroup('local-group', '/local/proj', null),
      projectGroup('remote-group', '/srv/remote', 'ssh-1')
    ],
    repos: [],
    worktreesByRepo: {}
  }
  useAppStore.setState(workspaces)
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function renderNameFilter(activeWorktreeId: string) {
  return renderHook(() => useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId }))
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json', 'src/main.ts'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  seedWorkspaces()
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialAppState, true)
})

describe('useFileExplorerNameFilter over the real runtime listing', () => {
  // Local workspaces return complete listings for client filtering; discarding them empties every query (#21423).
  it('projects a settled local listing instead of dropping it', async () => {
    const { result } = renderNameFilter(LOCAL_KEY)

    await act(async () => {
      result.current.setNameFilterQuery('package.')
    })
    await settle()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
    expect(result.current.nameFilterSource?.relativePaths).toEqual([
      'packages/app/package.json',
      'src/main.ts'
    ])
  })

  it('keeps the local listing across query edits without refetching it', async () => {
    const { result } = renderNameFilter(LOCAL_KEY)

    await act(async () => {
      result.current.setNameFilterQuery('pack')
    })
    await settle()
    await act(async () => {
      result.current.setNameFilterQuery('package.json')
    })
    await settle()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
    expect(result.current.nameFilterSource?.relativePaths).toEqual([
      'packages/app/package.json',
      'src/main.ts'
    ])
  })

  it('never projects the previous query answer after a remote query edit', async () => {
    vi.useFakeTimers()
    searchRuntimeFilePathsMock.mockResolvedValue({ files: ['first/hit.ts'], truncated: false })
    const projected: (readonly string[] | null | undefined)[] = []
    try {
      const { result } = renderHook(() => {
        const filter = useFileExplorerNameFilter({
          isFilesViewActive: true,
          activeWorktreeId: REMOTE_KEY
        })
        projected.push(filter.nameFilterSource?.relativePaths)
        return filter
      })

      await act(async () => {
        result.current.setNameFilterQuery('first')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      await settle()
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['first/hit.ts'])

      searchRuntimeFilePathsMock.mockResolvedValue({ files: ['second/hit.ts'], truncated: false })
      const rendersBeforeEdit = projected.length
      await act(async () => {
        result.current.setNameFilterQuery('second')
      })

      // The pre-effect render can leak the previous query’s result.
      expect(projected.length).toBeGreaterThan(rendersBeforeEdit)
      for (const paths of projected.slice(rendersBeforeEdit)) {
        expect(paths).toBeNull()
      }

      await act(async () => {
        await vi.advanceTimersByTimeAsync(120)
      })
      await settle()
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['second/hit.ts'])
    } finally {
      vi.useRealTimers()
    }
  })
})
