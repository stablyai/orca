import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PersistedUIState,
  Space,
  SpaceWorkspaceSelectionKey,
  WorkspaceKey
} from '../../../../shared/types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  DEFAULT_SPACE_ID,
  createSpaceWorkspaceSelectionKey,
  createDefaultSpace,
  getSpaceById,
  isRepoInSpace,
  normalizeActiveSpaceId,
  normalizeLastWorkspaceKeyBySpaceId,
  normalizeSpaces,
  parseSpaceWorkspaceSelectionKey,
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
} from '../../components/sidebar/worktree-list-space-filtering'

export type SpacesSlice = {
  spaces: Space[]
  activeSpaceId: string
  lastWorkspaceKeyBySpaceId: Record<string, SpaceWorkspaceSelectionKey>

  loadSpaces: () => Promise<void>
  setActiveSpace: (spaceId: string) => void
  rememberSpaceWorkspaceKey: (
    spaceId: string,
    workspaceKey: WorkspaceKey,
    hostId?: ExecutionHostId | null
  ) => void
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

function spacesSignature(spaces: readonly Space[]): string {
  return spaces.map((space) => `${space.id}\0${space.name}\0${space.emoji ?? ''}`).join('\n')
}

export function resolvePersistedSpaceUiState(
  ui: Pick<PersistedUIState, 'activeSpaceId' | 'lastWorkspaceKeyBySpaceId'>,
  spaces: readonly Space[]
): Pick<SpacesSlice, 'activeSpaceId' | 'lastWorkspaceKeyBySpaceId'> {
  return {
    activeSpaceId: normalizeActiveSpaceId(ui.activeSpaceId, spaces),
    lastWorkspaceKeyBySpaceId: normalizeLastWorkspaceKeyBySpaceId(
      ui.lastWorkspaceKeyBySpaceId,
      spaces
    )
  }
}

function restoreRememberedWorkspace(state: AppState, spaceId: string): void {
  const selection = parseSpaceWorkspaceSelectionKey(state.lastWorkspaceKeyBySpaceId[spaceId])
  const scope = selection ? parseWorkspaceKey(selection.workspaceKey) : null
  if (!scope) {
    return
  }
  if (scope.type === 'folder') {
    const workspace = findFolderWorkspaceOwner(state, scope.folderWorkspaceId, selection?.hostId)
    const visibleGroupIds = getActiveSpaceProjectGroupIdSet(
      state.projectGroups,
      state.repos,
      getActiveSpaceFilterId(spaceId, state.repos)
    )
    if (workspace && (!visibleGroupIds || visibleGroupIds.has(workspace.projectGroupId))) {
      state.setActiveFolderWorkspace(
        workspace.id,
        getExecutionHostIdForFolderWorkspace(state, workspace.id, selection?.hostId)
      )
    }
    return
  }
  const repo = state.repos.find(
    (candidate) =>
      (!selection?.hostId || getRepoExecutionHostId(candidate) === selection.hostId) &&
      (state.worktreesByRepo[candidate.id] ?? []).some(
        (worktree) => worktree.id === scope.worktreeId
      )
  )
  if (repo && isRepoInSpace(repo, spaceId)) {
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
      return spacesSignature(spaces) === spacesSignature(state.spaces) &&
        activeSpaceId === state.activeSpaceId
        ? state
        : { spaces, activeSpaceId }
    })
  }

  async function load(): Promise<void> {
    try {
      await reload()
    } catch (error) {
      console.error(error)
    }
  }

  async function mutate<T>(
    action: () => Promise<T | null | undefined> | undefined
  ): Promise<T | null> {
    let result: T | null | undefined
    try {
      result = await action()
    } catch (error) {
      console.error(error)
      return null
    }
    if (!result) {
      return null
    }
    try {
      await reload()
    } catch (error) {
      console.error(error)
    }
    return result
  }

  return {
    spaces: [createDefaultSpace()],
    activeSpaceId: DEFAULT_SPACE_ID,
    lastWorkspaceKeyBySpaceId: {},

    loadSpaces: load,

    setActiveSpace: (spaceId) => {
      const target = getSpaceById(get().spaces, spaceId)
      if (!target || target.id !== spaceId || target.id === get().activeSpaceId) {
        return
      }
      set({ activeSpaceId: target.id })
      persistSpaceUiState({ activeSpaceId: target.id })
      restoreRememberedWorkspace(get(), target.id)
    },

    rememberSpaceWorkspaceKey: (spaceId, workspaceKey, hostId) =>
      set((state) => {
        const resolved = resolveSpaceId(spaceId)
        const selection = createSpaceWorkspaceSelectionKey(workspaceKey, hostId)
        if (state.lastWorkspaceKeyBySpaceId[resolved] === selection) {
          return state
        }
        const lastWorkspaceKeyBySpaceId = {
          ...state.lastWorkspaceKeyBySpaceId,
          [resolved]: selection
        }
        persistSpaceUiState({ lastWorkspaceKeyBySpaceId })
        return { lastWorkspaceKeyBySpaceId }
      }),

    createSpace: async (input) => {
      const created = await mutate(() => spacesApi()?.create?.(input))
      if (created) {
        get().setActiveSpace(created.id)
        return true
      }
      return false
    },

    updateSpace: async (spaceId, updates) =>
      (await mutate(() => spacesApi()?.update?.({ spaceId, updates }))) !== null,

    deleteSpace: async (spaceId) => {
      if (spaceId === DEFAULT_SPACE_ID) {
        return false
      }
      return (await mutate(() => spacesApi()?.delete?.({ spaceId }))) !== null
    },

    moveProjectToSpace: async (projectId, spaceId, hostId) =>
      (await mutate(() => spacesApi()?.moveProject?.({ projectId, spaceId, hostId }))) !== null
  }
}
