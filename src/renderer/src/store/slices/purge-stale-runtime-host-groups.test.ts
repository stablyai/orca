import { describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

const { createTestStore } = await import('./store-test-helpers')

function group(id: string, executionHostId: string): ProjectGroup {
  return {
    id,
    name: 'root/repo',
    parentPath: '/srv',
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folder(id: string, executionHostId: ExecutionHostId): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group',
    name: 'folder',
    folderPath: '/srv/folder',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('purging a removed runtime’s project groups', () => {
  it('drops the removed server’s groups and folder rows, and keeps every other host’s', () => {
    const store = createTestStore()
    const kept = [group('local-group', 'local'), group('other', toRuntimeExecutionHostId('env-b'))]
    store.setState({
      projectGroups: [...kept, group('stopped', toRuntimeExecutionHostId('env-a'))],
      folderWorkspaces: [
        folder('local-folder', 'local'),
        folder('stopped-folder', toRuntimeExecutionHostId('env-a'))
      ]
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(store.getState().projectGroups.map((entry) => entry.id)).toEqual([
      'local-group',
      'other'
    ])
    expect(store.getState().folderWorkspaces.map((entry) => entry.id)).toEqual(['local-folder'])
  })

  it('leaves the state untouched when no group belongs to the removed server', () => {
    const store = createTestStore()
    const projectGroups = [group('local-group', 'local')]
    store.setState({ projectGroups, folderWorkspaces: [] })
    store.getState().purgeStaleRuntimeHostState(['env-a'])
    expect(store.getState().projectGroups).toBe(projectGroups)
  })
})
