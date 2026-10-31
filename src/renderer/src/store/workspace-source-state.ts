import type { AppState } from './types'
import type { WorkspaceSessionSnapshot } from '../lib/workspace-session'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  WorkspacePresentationDocuments,
  WorkspacePresentation
} from '../../../shared/workspace-presentation'
import type { WorkspacePresentationIndex } from './workspace-presentation-index'
export type WorkspaceCompositionState = { workspacePresentations?: WorkspacePresentationDocuments }
export const rawStates = new WeakMap<object, AppState>()
export const bindingIndexes = new WeakMap<object, WorkspacePresentationIndex>()
export function workspacePresentationFor(
  state: { workspacePresentations?: WorkspacePresentationDocuments },
  workspaceId: string
): WorkspacePresentation | undefined {
  const key = bindingIndexes.get(state)?.get(workspaceId)
  return key ? state.workspacePresentations?.[key] : undefined
}
export function workspaceSourceTab(
  state: {
    unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
    workspacePresentations?: WorkspacePresentationDocuments
  },
  tabId: string,
  workspaceId: string
) {
  const raw = rawStates.get(state)
  const tabs = raw?.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree ?? {}
  const exact = tabs[workspaceId]?.find((tab) => tab.id === tabId || tab.entityId === tabId)
  if (exact) {
    return exact
  }
  const view = raw ? workspacePresentationFor(state, workspaceId) : undefined
  for (const { source } of view?.baseline ?? []) {
    const found = tabs[source.workspaceId]?.find(
      (tab) => tab.id === tabId || tab.entityId === tabId
    )
    if (found) {
      return found
    }
  }
  return undefined
}
type WriteScope = {
  sources?: readonly string[]
  documents?: readonly string[]
  catalogRepoIds?: readonly string[]
}
export const sourceWrites = new WeakMap<object, WriteScope>()
export const documentChanges = new WeakMap<object, readonly string[]>()
export function noteWorkspacePresentationChanges(
  documents: WorkspacePresentationDocuments,
  keys: readonly string[]
): void {
  documentChanges.set(documents, keys)
}

export function rawWorkspaceState(state: AppState): AppState {
  return rawStates.get(state) ?? state
}
export function rawWorkspaceSnapshot(state: WorkspaceSessionSnapshot): WorkspaceSessionSnapshot {
  return rawStates.get(state) ?? state
}
/** Inventory/frame/hydration has already passed its own source-scoped admission fence. */
export function workspaceSourceWrite<T extends object>(patch: T, scope: WriteScope = {}): T {
  sourceWrites.set(patch, scope)
  return patch
}
export function workspaceSourceSession(state: AppState): WorkspaceSessionState {
  return {
    unifiedTabs: state.unifiedTabsByWorktree,
    tabGroups: state.groupsByWorktree,
    tabGroupLayouts: state.layoutByWorktree,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    activeTabIdByWorktree: state.activeTabIdByWorktree
  }
}

export function workspaceSourceGroup(
  state: {
    workspacePresentations?: WorkspacePresentationDocuments
    groupsByWorktree?: AppState['groupsByWorktree']
    activeGroupIdByWorktree?: AppState['activeGroupIdByWorktree']
  },
  workspaceId: string,
  groupId: string | undefined
): string | undefined {
  if (!workspacePresentationFor(state, workspaceId)) {
    return groupId
  }
  const raw = rawStates.get(state)
  const groups = (raw?.groupsByWorktree ?? state.groupsByWorktree)?.[workspaceId] ?? []
  return (
    groups.find((group) => group.id === groupId)?.id ??
    (raw?.activeGroupIdByWorktree ?? state.activeGroupIdByWorktree)?.[workspaceId] ??
    groups[0]?.id
  )
}
export function workspacePresentationRouteInputs(state: object): object | undefined {
  return bindingIndexes.get(state)
}
