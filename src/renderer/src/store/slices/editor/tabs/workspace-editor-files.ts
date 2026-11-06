import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'

type PlacementState = Pick<AppState, 'unifiedTabsByWorktree'> & { openFiles: readonly OpenFile[] }
const indexes = new WeakMap<readonly OpenFile[], Map<string, OpenFile>>()
export function openFileIndex(files: readonly OpenFile[]): ReadonlyMap<string, OpenFile> {
  let index = indexes.get(files)
  if (!index) {
    index = new Map(files.map((file) => [file.id, file]))
    indexes.set(files, index)
  }
  return index
}
/** Placement belongs to tabs; an unreferenced content record is never another visible tab. */
export function workspaceEditorFiles(state: PlacementState, workspaceId: string): OpenFile[] {
  const index = openFileIndex(state.openFiles)
  const ids = new Set(
    (state.unifiedTabsByWorktree[workspaceId] ?? [])
      .filter((tab) => isEditorTabContentType(tab.contentType))
      .map((tab) => tab.entityId)
  )
  return [...ids].flatMap((id) => {
    const file = index.get(id)
    return file ? [file] : []
  })
}
export function editorContentIsReferenced(
  state: Pick<AppState, 'unifiedTabsByWorktree'>,
  entityId: string,
  exceptTabId?: string
): boolean {
  return (
    hasPendingEntityTab(null, entityId) ||
    Object.values(state.unifiedTabsByWorktree).some((tabs) =>
      tabs.some(
        (tab) =>
          tab.id !== exceptTabId &&
          tab.entityId === entityId &&
          isEditorTabContentType(tab.contentType)
      )
    )
  )
}

type PlacementIndex = {
  workspaceByTabId: Map<string, string>
  workspacesByEntityId: Map<string, Set<string>>
}
const placementIndexes = new WeakMap<AppState['unifiedTabsByWorktree'], PlacementIndex>()
export function editorPlacementIndex(tabs: AppState['unifiedTabsByWorktree']): PlacementIndex {
  let index = placementIndexes.get(tabs)
  if (!index) {
    index = { workspaceByTabId: new Map(), workspacesByEntityId: new Map() }
    for (const [workspaceId, rows] of Object.entries(tabs)) {
      for (const tab of rows) {
        index.workspaceByTabId.set(tab.id, workspaceId)
        const owners = index.workspacesByEntityId.get(tab.entityId) ?? new Set<string>()
        owners.add(workspaceId)
        index.workspacesByEntityId.set(tab.entityId, owners)
      }
    }
    placementIndexes.set(tabs, index)
  }
  return index
}
export function editorTabWorkspace(
  tabs: AppState['unifiedTabsByWorktree'],
  tabId: string
): string | undefined {
  return editorPlacementIndex(tabs).workspaceByTabId.get(tabId)
}

export function editorOpenTabBarOrder(
  state: AppState,
  workspaceId: string,
  fileId: string
): Partial<AppState> {
  if (!state.tabBarOrderByWorktree) {
    return {}
  }
  const entities = [
    ...(state.tabsByWorktree[workspaceId] ?? []).map((tab) => tab.id),
    ...workspaceEditorFiles(state, workspaceId).map((file) => file.id),
    ...(state.browserTabsByWorktree[workspaceId] ?? []).map((tab) => tab.id)
  ]
  const live = new Set(entities)
  const order = (state.tabBarOrderByWorktree[workspaceId] ?? []).filter((id) => live.has(id))
  const seen = new Set(order)
  for (const id of [...entities, fileId]) {
    if (!seen.has(id)) {
      order.push(id)
      seen.add(id)
    }
  }
  return { tabBarOrderByWorktree: { ...state.tabBarOrderByWorktree, [workspaceId]: order } }
}
