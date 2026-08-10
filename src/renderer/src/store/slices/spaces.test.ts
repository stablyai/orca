import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createSpacesSlice } from './spaces'
import { createUISlice } from './ui'
import type { AppState } from '../types'
import type {
  FolderWorkspace,
  PersistedUIState,
  ProjectGroup,
  Repo,
  Space,
  Worktree
} from '../../../../shared/types'
import { DEFAULT_SPACE_ID, createDefaultSpace } from '../../../../shared/spaces'

const spacesApi = {
  list: vi.fn<() => Promise<Space[]>>(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn<() => Promise<boolean>>(),
  moveProject: vi.fn()
}
const uiSet = vi.fn().mockResolvedValue(undefined)
const setActiveWorktree = vi.fn()
const setActiveFolderWorkspace = vi.fn()

// @ts-expect-error test window mock
globalThis.window = { api: { spaces: spacesApi, ui: { set: uiSet } } }

const CUSTOM_SPACE_ID = 'space:work'

function makeSpace(id: string, name = 'Work'): Space {
  return { id, name, emoji: '🚀', createdAt: 1, updatedAt: 1 }
}

function makeRepo(id: string, spaceId: string | null): Repo {
  return { id, displayName: id, path: `/tmp/${id}`, badgeColor: '#000', addedAt: 0, spaceId }
}

function makeWorktree(id: string, repoId: string): Worktree {
  return { id, repoId, displayName: id } as Worktree
}

function makeGroup(id: string): ProjectGroup {
  return { id, parentGroupId: null } as ProjectGroup
}

function makeFolderWorkspace(id: string, projectGroupId: string): FolderWorkspace {
  return { id, projectGroupId } as FolderWorkspace
}

type TestStore = ReturnType<typeof createTestAppStore>

function createTestAppStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createUISlice(...a),
        repos: [],
        worktreesByRepo: {},
        projectGroups: [],
        folderWorkspaces: [],
        activeWorktreeId: 'repo-1::/tmp/wt-1',
        tabsByWorktree: { 'repo-1::/tmp/wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] },
        setActiveWorktree,
        setActiveFolderWorkspace,
        ...createSpacesSlice(...a)
      }) as unknown as AppState
  )
}

async function seedSpaces(store: TestStore, spaces: Space[]): Promise<void> {
  spacesApi.list.mockResolvedValue(spaces)
  await store.getState().loadSpaces()
}

describe('spaces slice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    uiSet.mockResolvedValue(undefined)
  })

  it('switches Spaces without tearing down workspace or session state', async () => {
    const store = createTestAppStore()
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])

    store.getState().setActiveSpace(CUSTOM_SPACE_ID)

    expect(store.getState().activeSpaceId).toBe(CUSTOM_SPACE_ID)
    expect(store.getState().activeWorktreeId).toBe('repo-1::/tmp/wt-1')
    expect(store.getState().tabsByWorktree).toEqual({
      'repo-1::/tmp/wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }]
    })
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(setActiveFolderWorkspace).not.toHaveBeenCalled()
    expect(uiSet).toHaveBeenCalledWith({ activeSpaceId: CUSTOM_SPACE_ID })
  })

  it('restores a remembered worktree on the host whose project lives in that Space', async () => {
    const store = createTestAppStore()
    store.setState({
      repos: [
        makeRepo('shared', null),
        { ...makeRepo('shared', CUSTOM_SPACE_ID), executionHostId: 'ssh:server' }
      ],
      worktreesByRepo: { shared: [makeWorktree('shared::/repo', 'shared')] }
    })
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])
    store.getState().rememberSpaceWorkspaceKey(CUSTOM_SPACE_ID, 'worktree:shared::/repo')

    store.getState().setActiveSpace(CUSTOM_SPACE_ID)

    expect(setActiveWorktree).toHaveBeenCalledWith('shared::/repo', 'ssh:server')
  })

  it('leaves the selection alone when the remembered workspace left the Space', async () => {
    const store = createTestAppStore()
    store.setState({
      repos: [makeRepo('repo-2', null)],
      worktreesByRepo: { 'repo-2': [makeWorktree('repo-2::/tmp/wt-2', 'repo-2')] }
    })
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])
    store.getState().rememberSpaceWorkspaceKey(CUSTOM_SPACE_ID, 'worktree:repo-2::/tmp/wt-2')

    store.getState().setActiveSpace(CUSTOM_SPACE_ID)

    expect(setActiveWorktree).not.toHaveBeenCalled()
  })

  it('does not restore a folder workspace whose group is outside the target Space', async () => {
    const store = createTestAppStore()
    store.setState({
      repos: [makeRepo('repo-2', null)],
      projectGroups: [makeGroup('group-1')],
      folderWorkspaces: [makeFolderWorkspace('folder-1', 'group-1')]
    })
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])
    store.getState().rememberSpaceWorkspaceKey(CUSTOM_SPACE_ID, 'folder:folder-1')

    store.getState().setActiveSpace(CUSTOM_SPACE_ID)

    expect(setActiveFolderWorkspace).not.toHaveBeenCalled()
  })

  it('ignores another window`s Space on a sync broadcast but restores it on startup', async () => {
    const store = createTestAppStore()
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])

    store.getState().hydratePersistedUI({ activeSpaceId: CUSTOM_SPACE_ID } as PersistedUIState)
    expect(store.getState().activeSpaceId).toBe(DEFAULT_SPACE_ID)

    store
      .getState()
      .hydratePersistedUI({ activeSpaceId: CUSTOM_SPACE_ID } as PersistedUIState, 'startup')
    expect(store.getState().activeSpaceId).toBe(CUSTOM_SPACE_ID)
  })

  it('falls back to the Default Space after deleting the active one', async () => {
    const store = createTestAppStore()
    await seedSpaces(store, [createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])
    store.getState().setActiveSpace(CUSTOM_SPACE_ID)
    spacesApi.delete.mockResolvedValue(true)
    spacesApi.list.mockResolvedValue([createDefaultSpace()])

    await store.getState().deleteSpace(CUSTOM_SPACE_ID)
    // Stands in for the repos:changed refresh the delete IPC handler broadcasts.
    await store.getState().loadSpaces()

    expect(store.getState().activeSpaceId).toBe(DEFAULT_SPACE_ID)
    expect(store.getState().spaces.map((space) => space.id)).toEqual([DEFAULT_SPACE_ID])
  })

  it('refreshes from the host after a mutation and switches into the new Space', async () => {
    const store = createTestAppStore()
    const created = makeSpace(CUSTOM_SPACE_ID)
    spacesApi.create.mockResolvedValue(created)
    spacesApi.list.mockResolvedValue([createDefaultSpace(), created])

    await store.getState().createSpace({ name: 'Work' })

    expect(store.getState().spaces.map((space) => space.id)).toEqual([
      DEFAULT_SPACE_ID,
      CUSTOM_SPACE_ID
    ])
    expect(store.getState().activeSpaceId).toBe(CUSTOM_SPACE_ID)
    expect(uiSet).toHaveBeenCalledWith({ activeSpaceId: CUSTOM_SPACE_ID })
  })

  it('reports a failed mutation instead of throwing at the call site', async () => {
    const store = createTestAppStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    spacesApi.moveProject.mockRejectedValue(new Error('nope'))

    const moved = await store.getState().moveProjectToSpace('repo-1', CUSTOM_SPACE_ID, 'local')

    expect(moved).toBe(false)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('updates only the addressed host project after moving it', async () => {
    const store = createTestAppStore()
    store.setState({
      repos: [
        makeRepo('shared', null),
        { ...makeRepo('shared', null), executionHostId: 'ssh:server' }
      ]
    })
    spacesApi.moveProject.mockResolvedValue(true)
    spacesApi.list.mockResolvedValue([createDefaultSpace(), makeSpace(CUSTOM_SPACE_ID)])

    await store.getState().moveProjectToSpace('shared', CUSTOM_SPACE_ID, 'ssh:server')

    expect(store.getState().repos).toEqual([
      makeRepo('shared', null),
      { ...makeRepo('shared', CUSTOM_SPACE_ID), executionHostId: 'ssh:server' }
    ])
  })
})
