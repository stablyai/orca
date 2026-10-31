import {
  sourceTabEntity,
  workspaceEntityKey,
  workspaceSourceOwnsTab
} from '../../../shared/workspace-presentation'
import type { Tab } from '../../../shared/tab-types'
import type { AppState } from './types'
import type { WorkspaceSessionSnapshot } from '../lib/workspace-session'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  WorkspacePresentationDocuments,
  WorkspacePresentation,
  WorkspaceSourceRef
} from '../../../shared/workspace-presentation'
import type { WorkspacePresentationIndex } from './workspace-presentation-index'
import { workspaceTabCandidates } from '../lib/structured-chat-tab-index'
export type WorkspaceCompositionState = { workspacePresentations?: WorkspacePresentationDocuments }
export const readViews = new WeakMap<object, (raw: AppState) => AppState>()
export function workspaceReadState(state: AppState): AppState {
  const raw = rawWorkspaceState(state)
  return readViews.get(raw)?.(raw) ?? state
}
export const rawStates = new WeakMap<object, AppState>()
export const documentIndexes = new WeakMap<object, WorkspacePresentationIndex>()
export const bindingIndexes = new WeakMap<object, WorkspacePresentationIndex>()
export function workspacePresentationFor(
  state: { workspacePresentations?: WorkspacePresentationDocuments },
  workspaceId: string
): WorkspacePresentation | undefined {
  const key = (
    bindingIndexes.get(state) ??
    (state.workspacePresentations && documentIndexes.get(state.workspacePresentations))
  )?.get(workspaceId)
  return key ? state.workspacePresentations?.[key] : undefined
}
type SourceTabState = {
  unifiedTabsByWorktree?: Record<string, readonly Tab[] | undefined>
  workspacePresentations?: WorkspacePresentationDocuments
}
const placements = new WeakMap<
  WorkspacePresentation['tabs'],
  Map<string, WorkspacePresentation['tabs'][number]>
>()
function placementFor(saved: WorkspacePresentation, id: string) {
  let index = placements.get(saved.tabs)
  if (!index) {
    index = new Map()
    for (const tab of saved.tabs) {
      for (const key of [tab.id, tab.entity.entityId]) {
        if (!index.has(key)) {
          index.set(key, tab)
        }
      }
    }
    placements.set(saved.tabs, index)
  }
  return index.get(id)
}

/** Resolve the actual host-qualified occurrence, never an outer group or lexical path alias. */
export function workspaceSourceOccurrence(
  state: SourceTabState,
  tabId: string,
  workspaceId: string
) {
  const raw = rawStates.get(state)
  const tabs = raw?.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree ?? {}
  const presentation = workspacePresentationFor(state, workspaceId)
  const placement = presentation && placementFor(presentation, tabId)
  if (presentation) {
    for (const { source } of presentation.baseline) {
      const tab = workspaceTabCandidates(tabs[source.workspaceId], tabId).find(
        (candidate) =>
          workspaceSourceOwnsTab(candidate, source) &&
          (!placement ||
            workspaceEntityKey(sourceTabEntity(candidate, source)) ===
              workspaceEntityKey(placement.entity))
      )
      if (tab) {
        return { tab, source, presentation }
      }
    }
    return undefined
  }
  const tab = workspaceTabCandidates(tabs[workspaceId], tabId)[0]
  const source: WorkspaceSourceRef | undefined = tab
    ? { hostId: tab.executionHostId ?? 'local', workspaceId: tab.worktreeId }
    : undefined
  return tab && source ? { tab, source, presentation: undefined } : undefined
}
export function workspaceSourceTab(state: SourceTabState, tabId: string, workspaceId: string) {
  return workspaceSourceOccurrence(state, tabId, workspaceId)?.tab
}

/** The gesture context and the resource's literal source are independent. */
export function workspaceTabDisplayId(
  state: SourceTabState,
  sourceId: string,
  tabId: string
): string {
  const saved = workspacePresentationFor(state, sourceId)
  return saved && workspaceSourceTab(state, tabId, saved.displayWorkspaceId)
    ? saved.displayWorkspaceId
    : sourceId
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
    groups.find(
      (group) =>
        group.id === (raw?.activeGroupIdByWorktree ?? state.activeGroupIdByWorktree)?.[workspaceId]
    )?.id ??
    groups[0]?.id
  )
}
export function workspacePresentationRouteInputs(state: object): object | undefined {
  return bindingIndexes.get(state)
}
