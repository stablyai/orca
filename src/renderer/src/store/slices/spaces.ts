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

export const createSpacesSlice: StateCreator<AppState, [], [], SpacesSlice> = (set, get) => {
  async function reload(): Promise<void> {
    const list = await spacesApi()?.list?.()
    if (!list) {
      return
    }
    set((state) => {
      const spaces = normalizeSpaces(list)
      const activeSpaceId = normalizeActiveSpaceId(state.activeSpaceId, spaces)
      if (activeSpaceId !== state.activeSpaceId) {
        persistSpaceUiState({ activeSpaceId })
      }
      return { spaces, activeSpaceId }
    })
  }

  async function load(): Promise<void> {
    try {
      await reload()
    } catch (error) {
      console.error(error)
    }
  }

  // Why: every spaces:* IPC handler emits repos:changed, which refreshes the list; only ordering-sensitive callers reload inline.
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

    updateSpace: async (spaceId, updates) =>
      (await mutate(() => spacesApi()?.update?.({ spaceId, updates }))) !== null,

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
