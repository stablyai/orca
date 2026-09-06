import { GRAB_BUDGET } from '../../../../../shared/browser-grab-types'
import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import { findPage, findWorkspace } from '../browser-page-records'
import { sanitizeBrowserPageAnnotation } from './browser-page-annotation'

export function createBrowserPageMetadataActions(
  set: BrowserSliceSet,
  _get: BrowserSliceGet
): Pick<
  BrowserSlice,
  | 'setRemoteBrowserPageHandle'
  | 'removeRemoteBrowserPageHandle'
  | 'setBrowserPageViewportPreset'
  | 'addBrowserPageAnnotation'
  | 'updateBrowserPageAnnotation'
  | 'deleteBrowserPageAnnotation'
  | 'clearBrowserPageAnnotations'
> {
  return {
    setRemoteBrowserPageHandle: (pageId, handle) => {
      set((s) => ({
        remoteBrowserPageHandlesByPageId: {
          ...s.remoteBrowserPageHandlesByPageId,
          [pageId]: handle
        }
      }))
    },

    removeRemoteBrowserPageHandle: (pageId, remotePageId) => {
      let removedHandle: RemoteBrowserPageHandle | null = null
      set((s) => {
        const current = s.remoteBrowserPageHandlesByPageId[pageId]
        if (!current || (remotePageId && current.remotePageId !== remotePageId)) {
          return s
        }
        removedHandle = current
        const nextRemoteBrowserPageHandlesByPageId = {
          ...s.remoteBrowserPageHandlesByPageId
        }
        delete nextRemoteBrowserPageHandlesByPageId[pageId]
        return { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
      })
      return removedHandle
    },

    // viewportPresetId is intentionally page-local (no workspace-layer UI consumer); do NOT add mirrorWorkspaceFromActivePage here.
    setBrowserPageViewportPreset: (pageId, viewportPresetId) =>
      set((s) => {
        const page = findPage(s.browserPagesByWorkspace, pageId)
        if (!page) {
          return s
        }
        const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
        if (!workspace) {
          return s
        }
        const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
          entry.id === pageId ? { ...entry, viewportPresetId } : entry
        )
        return {
          browserPagesByWorkspace: {
            ...s.browserPagesByWorkspace,
            [workspace.id]: nextPages
          }
        }
      }),

    addBrowserPageAnnotation: (annotation) =>
      set((s) => {
        const existing = s.browserAnnotationsByPageId[annotation.browserPageId] ?? []
        const next = [...existing, sanitizeBrowserPageAnnotation(annotation)].slice(
          -GRAB_BUDGET.annotationsMaxPerPage
        )
        return {
          browserAnnotationsByPageId: {
            ...s.browserAnnotationsByPageId,
            [annotation.browserPageId]: next
          }
        }
      }),

    updateBrowserPageAnnotation: (pageId, annotationId, patch) =>
      set((s) => {
        const existing = s.browserAnnotationsByPageId[pageId] ?? []
        const target = existing.find((annotation) => annotation.id === annotationId)
        if (!target) {
          return s
        }
        const updated = sanitizeBrowserPageAnnotation({ ...target, ...patch })
        return {
          browserAnnotationsByPageId: {
            ...s.browserAnnotationsByPageId,
            [pageId]: existing.map((annotation) =>
              annotation.id === annotationId ? updated : annotation
            )
          }
        }
      }),

    deleteBrowserPageAnnotation: (pageId, annotationId) =>
      set((s) => {
        const existing = s.browserAnnotationsByPageId[pageId] ?? []
        const next = existing.filter((annotation) => annotation.id !== annotationId)
        if (next.length === existing.length) {
          return s
        }
        const nextByPageId = { ...s.browserAnnotationsByPageId }
        if (next.length > 0) {
          nextByPageId[pageId] = next
        } else {
          delete nextByPageId[pageId]
        }
        return { browserAnnotationsByPageId: nextByPageId }
      }),

    clearBrowserPageAnnotations: (pageId) =>
      set((s) => {
        if (!s.browserAnnotationsByPageId[pageId]?.length) {
          return s
        }
        const nextByPageId = { ...s.browserAnnotationsByPageId }
        delete nextByPageId[pageId]
        return { browserAnnotationsByPageId: nextByPageId }
      })
  }
}
