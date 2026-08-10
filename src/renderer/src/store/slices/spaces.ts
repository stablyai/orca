import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PersistedUIState, Space, WorkspaceKey } from '../../../../shared/types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  DEFAULT_SPACE_ID,
  clearRepoSpaceMembership,
  createDefaultSpace,
  isDefaultSpaceId,
  isRepoInSpace,
  normalizeActiveSpaceId,
  normalizeSpaces,
  resolveSpaceId,
  type SpaceCreateInput,
  type SpaceUpdates
} from '../../../../shared/spaces'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  findFolderWorkspaceOwner,
  getExecutionHostIdForFolderWorkspace
} from '../../lib/folder-workspace-runtime-owner'
import {
  getActiveSpaceFilterId,
  getActiveSpaceProjectGroupIdSet
} from '../../components/sidebar/space-scoping'

export type SpacesSlice = {
  spaces: Space[]
  activeSpaceId: string
  /** Session-only: switching back into a Space reopens the workspace last used there. */
  lastWorkspaceKeyBySpaceId: Record<string, WorkspaceKey>

  loadSpaces: () => Promise<void>
  setActiveSpace: (spaceId: string) => void
  rememberSpaceWorkspaceKey: (spaceId: string, workspaceKey: WorkspaceKey) => void
  createSpace: (input: SpaceCreateInput) => Promise<boolean>
  updateSpace: (spaceId: string, updates: SpaceUpdates) => Promise<boolean>
  deleteSpace: (spaceId: string) => Promise<boolean>
  moveProjectToSpace: (
    projectId: string,
    spaceId: string | null,
    hostId: ExecutionHostId
  ) => Promise<boolean>
}

function spacesApi(): Partial<Window['api']['spaces']> | undefined {
  return typeof window === 'undefined' || isWebClient() ? undefined : window.api?.spaces
}

function isWebClient(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

function persistSpaceUiState(patch: Partial<PersistedUIState>): void {
  if (typeof window !== 'undefined' && !isWebClient()) {
    void window.api?.ui?.set(patch)?.catch(console.error)
  }
}

function restoreRememberedWorkspace(state: AppState, spaceId: string): void {
  const remembered = state.lastWorkspaceKeyBySpaceId[spaceId]
  const scope = remembered ? parseWorkspaceKey(remembered) : null
  if (!scope) {
    return
  }
  if (scope.type === 'folder') {
    const workspace = findFolderWorkspaceOwner(state, scope.folderWorkspaceId)
    const visibleGroupIds = getActiveSpaceProjectGroupIdSet(
      state.projectGroups,
      state.repos,
      getActiveSpaceFilterId(spaceId, state.repos)
    )
    if (workspace && (!visibleGroupIds || visibleGroupIds.has(workspace.projectGroupId))) {
      state.setActiveFolderWorkspace(
        workspace.id,
        getExecutionHostIdForFolderWorkspace(state, workspace.id)
      )
    }
    return
  }
  // Why: the same repo can exist on several hosts; only the copy inside the Space may claim the selection.
  const repo = state.repos.find(
    (candidate) =>
      isRepoInSpace(candidate, spaceId) &&
      (state.worktreesByRepo[candidate.id] ?? []).some(
        (worktree) => worktree.id === scope.worktreeId
      )
  )
  if (repo) {
    state.setActiveWorktree(scope.worktreeId, getRepoExecutionHostId(repo))
  }
}

function spacesEqual(left: readonly Space[], right: readonly Space[]): boolean {
  return (
    left.length === right.length &&
    left.every((space, index) => {
      const other = right[index]
      return (
        space.id === other.id &&
        space.name === other.name &&
        space.emoji === other.emoji &&
        space.createdAt === other.createdAt &&
        space.updatedAt === other.updatedAt
      )
    })
  )
}

export const createSpacesSlice: StateCreator<AppState, [], [], SpacesSlice> = (set, get) => {
  // Why: repos:changed fires far more often than Spaces actually change, and a late list must not
  // roll back a newer one — the fallback would drop the caller into Default.
  let listGeneration = 0

  async function reload(): Promise<void> {
    const generation = ++listGeneration
    const list = await spacesApi()?.list?.()
    if (!list || generation !== listGeneration) {
      return
    }
    set((state) => {
      const normalized = normalizeSpaces(list)
      // Why: a fresh array identity re-renders every Space subscriber, sidebars included.
      const spaces = spacesEqual(state.spaces, normalized) ? state.spaces : normalized
      const activeSpaceId = normalizeActiveSpaceId(state.activeSpaceId, spaces)
      if (activeSpaceId !== state.activeSpaceId) {
        persistSpaceUiState({ activeSpaceId })
        return { spaces, activeSpaceId }
      }
      return spaces === state.spaces ? state : { spaces }
    })
  }

  async function load(): Promise<void> {
    try {
      await reload()
    } catch (error) {
      console.error(error)
    }
  }

  // Why: spaces:changed refreshes the OTHER windows. The window that asked reloads inline instead
  // of waiting on that round trip, so its own list never depends on the broadcast arriving.
  async function mutate<T>(
    action: () => Promise<T | null | undefined> | undefined
  ): Promise<T | null> {
    try {
      return (await action()) || null
    } catch (error) {
      console.error(error)
      return null
    }
  }

  return {
    spaces: [createDefaultSpace()],
    activeSpaceId: DEFAULT_SPACE_ID,
    lastWorkspaceKeyBySpaceId: {},

    loadSpaces: load,

    setActiveSpace: (spaceId) => {
      const target = get().spaces.find((space) => space.id === spaceId)
      if (!target || target.id === get().activeSpaceId) {
        return
      }
      set({ activeSpaceId: target.id })
      persistSpaceUiState({ activeSpaceId: target.id })
      restoreRememberedWorkspace(get(), target.id)
    },

    rememberSpaceWorkspaceKey: (spaceId, workspaceKey) =>
      set((state) => {
        const resolved = resolveSpaceId(spaceId)
        return state.lastWorkspaceKeyBySpaceId[resolved] === workspaceKey
          ? state
          : {
              lastWorkspaceKeyBySpaceId: {
                ...state.lastWorkspaceKeyBySpaceId,
                [resolved]: workspaceKey
              }
            }
      }),

    createSpace: async (input) => {
      const created = await mutate(() => spacesApi()?.create?.(input))
      if (!created) {
        return false
      }
      // Why: setActiveSpace only accepts a Space already in state, so don't wait for the repos:changed refresh.
      await load()
      get().setActiveSpace(created.id)
      return true
    },

    updateSpace: async (spaceId, updates) => {
      if ((await mutate(() => spacesApi()?.update?.({ spaceId, updates }))) === null) {
        return false
      }
      await load()
      return true
    },

    deleteSpace: async (spaceId) => {
      if (spaceId === DEFAULT_SPACE_ID) {
        return false
      }
      if ((await mutate(() => spacesApi()?.delete?.({ spaceId }))) === null) {
        return false
      }
      // Why: a recreated Space could otherwise inherit the dead one's remembered workspace.
      set((state) => {
        const { [spaceId]: _removed, ...rest } = state.lastWorkspaceKeyBySpaceId
        return { lastWorkspaceKeyBySpaceId: rest }
      })
      await load()
      return true
    },

    moveProjectToSpace: async (projectId, spaceId, hostId) => {
      const moved = await mutate(() => spacesApi()?.moveProject?.({ projectId, spaceId, hostId }))
      if (!moved) {
        return false
      }
      const storedSpaceId = isDefaultSpaceId(spaceId) ? null : spaceId
      set((state) => ({
        repos: state.repos.map((repo) =>
          repo.id === projectId && getRepoExecutionHostId(repo) === hostId
            ? storedSpaceId
              ? { ...repo, spaceId: storedSpaceId }
              : clearRepoSpaceMembership(repo)
            : repo
        )
      }))
      return true
    }
  }
}
