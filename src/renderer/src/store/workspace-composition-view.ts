import type { AppState } from './types'
import { ImmutableInputCache, absentImmutableInput } from '../../../shared/immutable-input-cache'
import { WorkspacePresentationIndex } from './workspace-presentation-index'
import { deriveActiveSurfaceForWorktree } from './slices/tabs/tabs-surface'
import {
  rawStates,
  bindingIndexes,
  documentChanges,
  readViews,
  documentIndexes
} from './workspace-source-state'
import {
  isWorkspacePresentationKey,
  type WorkspacePresentationDocuments
} from '../../../shared/workspace-presentation'
import { buildWorkspaceProjection, composedWorkspace } from './workspace-composition-projection'
export function createWorkspaceCompositionView() {
  let index = new WorkspacePresentationIndex()
  let indexedDocuments: WorkspacePresentationDocuments | undefined
  const indexDocuments = (
    documents: WorkspacePresentationDocuments | undefined,
    keys?: readonly string[]
  ): void => {
    if (documents === indexedDocuments) {
      return
    }
    keys ??= documents ? documentChanges.get(documents) : undefined
    if (!keys) {
      index = new WorkspacePresentationIndex()
    }
    for (const key of keys ?? Object.keys(documents ?? {})) {
      const before = isWorkspacePresentationKey(key) ? indexedDocuments?.[key] : undefined
      const saved = isWorkspacePresentationKey(key) ? documents?.[key] : undefined
      if (
        keys &&
        before &&
        saved &&
        before.displayWorkspaceId === saved.displayWorkspaceId &&
        before.baseline.length === saved.baseline.length &&
        before.baseline.every(
          (entry, at) => entry.source.workspaceId === saved.baseline[at].source.workspaceId
        )
      ) {
        continue
      }
      if (before) {
        for (const id of [
          before.displayWorkspaceId,
          ...before.baseline.map(({ source }) => source.workspaceId)
        ]) {
          if (index.get(id) === key) {
            index = index.delete(id)
          }
        }
      }
      if (saved && isWorkspacePresentationKey(key)) {
        index = index.set(saved.displayWorkspaceId, key)
        for (const { source } of saved.baseline) {
          index = index.set(source.workspaceId, key)
        }
      }
    }
    indexedDocuments = documents
    if (documents) {
      documentIndexes.set(documents, index)
    }
  }
  const views = new WeakMap<AppState, AppState>()
  const projections = new ImmutableInputCache<Partial<AppState>>()
  const surfaces = new ImmutableInputCache<Partial<AppState>>()
  const project = (raw: AppState): AppState => {
    const known = views.get(raw)
    if (known) {
      return known
    }
    indexDocuments(raw.workspacePresentations)
    readViews.set(raw, project)
    bindingIndexes.set(raw, index)
    const inputs = [
      raw.workspacePresentations ?? absentImmutableInput,
      raw.unifiedTabsByWorktree,
      raw.groupsByWorktree,
      raw.layoutByWorktree,
      raw.activeGroupIdByWorktree,
      raw.tabsByWorktree,
      raw.browserTabsByWorktree,
      raw.activeTabIdByWorktree,
      raw.activeFileIdByWorktree,
      raw.activeBrowserTabIdByWorktree,
      raw.activeTabTypeByWorktree
    ]
    let projection = projections.get(inputs, 'projection')
    if (!projection) {
      projection = buildWorkspaceProjection(
        {
          workspacePresentations: raw.workspacePresentations,
          unifiedTabsByWorktree: raw.unifiedTabsByWorktree,
          groupsByWorktree: raw.groupsByWorktree,
          layoutByWorktree: raw.layoutByWorktree,
          activeGroupIdByWorktree: raw.activeGroupIdByWorktree,
          tabsByWorktree: raw.tabsByWorktree,
          browserTabsByWorktree: raw.browserTabsByWorktree,
          activeTabIdByWorktree: raw.activeTabIdByWorktree,
          activeFileIdByWorktree: raw.activeFileIdByWorktree,
          activeBrowserTabIdByWorktree: raw.activeBrowserTabIdByWorktree,
          activeTabTypeByWorktree: raw.activeTabTypeByWorktree
        },
        index
      )
      projections.set(inputs, 'projection', projection)
    }
    const bindingIndex = index
    const id = raw.activeWorktreeId
    const activeKey = id ? bindingIndex.get(id) : undefined
    const activeSaved = activeKey ? raw.workspacePresentations?.[activeKey] : undefined
    const active = activeSaved ? composedWorkspace(raw, activeSaved) : undefined
    const surfaceInputs = [
      raw.openFiles,
      active ?? absentImmutableInput,
      raw.activeFileIdByWorktree,
      raw.activeBrowserTabIdByWorktree,
      raw.activeTabIdByWorktree,
      raw.activeTabTypeByWorktree
    ]
    const surfaceKey = id ?? ''
    let activeSurface = surfaces.get(surfaceInputs, surfaceKey)
    if (!activeSurface) {
      activeSurface =
        id && activeSaved
          ? (() => {
              const surfaceState = { ...raw, ...projection }
              bindingIndexes.set(surfaceState, bindingIndex)
              return deriveActiveSurfaceForWorktree(surfaceState, id)
            })()
          : {}
      surfaces.set(surfaceInputs, surfaceKey, activeSurface)
    }
    const view = { ...raw, ...projection, ...activeSurface }
    bindingIndexes.set(raw, bindingIndex)
    bindingIndexes.set(view, bindingIndex)
    views.set(raw, view)
    rawStates.set(view, raw)
    return view
  }

  return {
    project,
    presentationIndex: () => index,
    indexDocuments,
    documentKey: (id: string) => index.get(id),
    acknowledgeSettlement: (documents: WorkspacePresentationDocuments | undefined) => {
      indexedDocuments = documents
      if (documents) {
        documentIndexes.set(documents, index)
      }
    }
  }
}
