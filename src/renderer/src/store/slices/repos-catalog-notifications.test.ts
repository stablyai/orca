import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { createTestStore } from './store-test-helpers'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'Group',
  parentPath: '/parent',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 3
}
const folder: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: group.id,
  name: 'Folder',
  folderPath: '/parent/folder',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 3
}
const groupsList = vi.fn<() => Promise<ProjectGroup[]>>()
const foldersList = vi.fn<() => Promise<FolderWorkspace[]>>()
const folderUpdate = vi.fn<Window['api']['folderWorkspaces']['update']>()
type TestStore = ReturnType<typeof createTestStore>
type CatalogCase = {
  label: string
  catalog: 'projectGroups' | 'folderWorkspaces'
  refresh: (store: TestStore) => Promise<void>
}
const cases: CatalogCase[] = [
  {
    label: 'selected groups',
    catalog: 'projectGroups',
    refresh: (s) => s.getState().fetchProjectGroups()
  },
  {
    label: 'all-host local groups',
    catalog: 'projectGroups',
    refresh: (s) => s.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
  },
  {
    label: 'selected folders',
    catalog: 'folderWorkspaces',
    refresh: (s) => s.getState().fetchFolderWorkspaces()
  },
  {
    label: 'all-host local folders',
    catalog: 'folderWorkspaces',
    refresh: (s) => s.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
  }
]

beforeEach(() => {
  groupsList.mockReset().mockImplementation(async () => structuredClone([group]))
  foldersList.mockReset().mockImplementation(async () => structuredClone([folder]))
  folderUpdate.mockReset()
  vi.stubGlobal('window', {
    api: {
      projectGroups: { list: groupsList },
      folderWorkspaces: { list: foldersList, update: folderUpdate },
      runtimeEnvironments: { list: async () => [] }
    },
    dispatchEvent: vi.fn()
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function seed(): TestStore {
  const store = createTestStore()
  store.setState({
    projectGroups: [{ ...group, executionHostId: 'local' }],
    folderWorkspaces: [{ ...folder, executionHostId: 'local' }],
    folderWorkspacePathStatuses: {
      cached: {
        status: { path: folder.folderPath, exists: true },
        checkedAt: 1,
        requestSnapshot: 'snapshot'
      }
    }
  })
  return store
}

it.each(cases)('does not notify for ten equal $label refreshes', async ({ refresh, catalog }) => {
  const store = seed()
  const initial = store.getState()
  const changed = vi.fn()
  const unsubscribe = store.subscribe(changed)
  for (let index = 0; index < 10; index += 1) {
    await refresh(store)
  }
  unsubscribe()
  expect(changed).not.toHaveBeenCalled()
  expect(store.getState()).toBe(initial)
  expect(store.getState()[catalog]).toBe(initial[catalog])
  expect(store.getState().folderWorkspacePathStatuses).toBe(initial.folderWorkspacePathStatuses)
})

it.each(cases)(
  'publishes changed $label and invalidates path statuses',
  async ({ refresh, catalog }) => {
    const store = seed()
    groupsList.mockResolvedValue([{ ...group, name: 'Changed group' }])
    foldersList.mockResolvedValue([{ ...folder, name: 'Changed folder' }])
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    await refresh(store)
    unsubscribe()
    expect(changed).toHaveBeenCalledOnce()
    expect(store.getState()[catalog][0]?.name).toMatch(/^Changed /)
    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  }
)

it.each(cases)('retains state after a failed $label read', async ({ refresh }) => {
  const store = seed()
  const initial = store.getState()
  groupsList.mockRejectedValue(new Error('offline'))
  foldersList.mockRejectedValue(new Error('offline'))
  const changed = vi.fn()
  const unsubscribe = store.subscribe(changed)
  await refresh(store)
  unsubscribe()
  expect(store.getState()).toBe(initial)
  expect(changed).not.toHaveBeenCalled()
})

it.each(cases)(
  'fences an older $label response after a newer no-op response',
  async ({ refresh, catalog }) => {
    const store = seed()
    const initial = store.getState()
    const olderGroups = Promise.withResolvers<ProjectGroup[]>()
    const olderFolders = Promise.withResolvers<FolderWorkspace[]>()
    if (catalog === 'projectGroups') {
      groupsList.mockReturnValueOnce(olderGroups.promise)
    } else {
      foldersList.mockReturnValueOnce(olderFolders.promise)
    }
    const older = refresh(store)
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    await refresh(store)
    olderGroups.resolve([{ ...group, name: 'Obsolete group' }])
    olderFolders.resolve([{ ...folder, name: 'Obsolete folder' }])
    await older
    unsubscribe()
    expect(store.getState()).toBe(initial)
    expect(changed).not.toHaveBeenCalled()
  }
)

it.each(cases.filter((entry) => entry.catalog === 'folderWorkspaces'))(
  'keeps update revision fencing after an equal $label response',
  async ({ refresh }) => {
    const store = seed()
    const pending = Promise.withResolvers<FolderWorkspace>()
    folderUpdate.mockReturnValueOnce(pending.promise)
    const update = store.getState().updateFolderWorkspace(folder.id, { isUnread: true })
    const initial = store.getState()
    await refresh(store)
    expect(store.getState()).toBe(initial)
    pending.resolve({ ...folder, isUnread: true, updatedAt: 2 })
    await update
    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(3)
  }
)

it('accepts a newer update after an equal catalog response', async () => {
  const store = seed()
  const pending = Promise.withResolvers<FolderWorkspace>()
  folderUpdate.mockReturnValueOnce(pending.promise)
  const update = store.getState().updateFolderWorkspace(folder.id, { isUnread: true })
  await store.getState().fetchFolderWorkspaces()
  pending.resolve({ ...folder, isUnread: true, updatedAt: 4 })
  await update
  expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(true)
  expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(4)
})

it('still clears restored folder owners after a successful all-host refresh', async () => {
  const store = seed()
  store.setState({
    restoredRuntimeHostIdByWorkspaceSessionKey: {
      'folder:folder-1': 'runtime:retired',
      unrelated: 'runtime:kept'
    }
  })
  const changed = vi.fn()
  const unsubscribe = store.subscribe(changed)
  await store.getState().fetchFolderWorkspacesForAllHosts()
  unsubscribe()
  expect(changed).toHaveBeenCalledOnce()
  expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
    unrelated: 'runtime:kept'
  })
})
