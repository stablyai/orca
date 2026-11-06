import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'
import { hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'

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
export function workspaceEditorFiles(
  files: readonly OpenFile[],
  tabs: readonly Tab[] | undefined
): OpenFile[] {
  const index = openFileIndex(files)
  const ids = new Set(
    (tabs ?? []).filter((tab) => isEditorTabContentType(tab.contentType)).map((tab) => tab.entityId)
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
  const index = editorPlacementIndex(state.unifiedTabsByWorktree)
  const references = index.tabIdsByEntityId.get(entityId)
  return Boolean(
    (references && (references.size > 1 || !exceptTabId || !references.has(exceptTabId))) ||
    hasPendingEntityTab(null, entityId)
  )
}

type PlacementIndex = {
  tabById: Map<string, Tab>
  workspaceByTabId: Map<string, string>
  workspacesByEntityId: Map<string, Set<string>>
  tabIdsByEntityId: Map<string, Set<string>>
}
const placementIndexes = new WeakMap<AppState['unifiedTabsByWorktree'], PlacementIndex>()
export function editorPlacementIndex(tabs: AppState['unifiedTabsByWorktree']): PlacementIndex {
  let index = placementIndexes.get(tabs)
  if (!index) {
    index = {
      tabById: new Map(),
      workspaceByTabId: new Map(),
      workspacesByEntityId: new Map(),
      tabIdsByEntityId: new Map()
    }
    for (const [workspaceId, rows] of Object.entries(tabs)) {
      for (const tab of rows) {
        index.tabById.set(tab.id, tab)
        index.workspaceByTabId.set(tab.id, workspaceId)
        if (!isEditorTabContentType(tab.contentType)) {
          continue
        }
        const tabIds = index.tabIdsByEntityId.get(tab.entityId) ?? new Set<string>()
        tabIds.add(tab.id)
        index.tabIdsByEntityId.set(tab.entityId, tabIds)
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
    ...workspaceEditorFiles(state.openFiles, state.unifiedTabsByWorktree[workspaceId]).map(
      (file) => file.id
    ),
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
