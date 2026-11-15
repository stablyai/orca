import { isBrowserAnnotationPageFull } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserSlice, BrowserSliceSet } from '../browser-slice-contract'

import {
  retainBrowserAnnotationMarkerIds,
  sanitizeBrowserPageAnnotation
} from '../annotations/browser-page-annotation'
import { omitRecordKeys } from '../../worktrees/teardown/record-key-omission'

export function createBrowserAnnotationActions(
  set: BrowserSliceSet
): Pick<
  BrowserSlice,
  | 'addBrowserPageAnnotation'
  | 'updateBrowserPageAnnotation'
  | 'deleteBrowserPageAnnotation'
  | 'clearBrowserPageAnnotations'
  | 'invalidateBrowserPageAnnotationGeometry'
  | 'removeDeliveredBrowserPageAnnotations'
> {
  return {
    addBrowserPageAnnotation: (annotation) =>
      set((s) => {
        const existing = s.browserAnnotationsByPageId[annotation.browserPageId] ?? []
        // A full page refuses new notes; evicting the oldest would lose feedback unseen.
        if (isBrowserAnnotationPageFull(existing.length)) {
          return s
        }
        const next = [...existing, sanitizeBrowserPageAnnotation(annotation)]
        return {
          browserAnnotationsByPageId: {
            ...s.browserAnnotationsByPageId,
            [annotation.browserPageId]: next
          },
          browserAnnotationMarkerIdsByPageId: retainBrowserAnnotationMarkerIds(
            s.browserAnnotationMarkerIdsByPageId,
            annotation.browserPageId,
            next,
            annotation.id
          )
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
        return {
          browserAnnotationsByPageId: nextByPageId,
          browserAnnotationMarkerIdsByPageId: retainBrowserAnnotationMarkerIds(
            s.browserAnnotationMarkerIdsByPageId,
            pageId,
            next
          )
        }
      }),
    clearBrowserPageAnnotations: (pageId) =>
      set((s) => {
        const notes = omitRecordKeys(s.browserAnnotationsByPageId, [pageId])
        const markers = omitRecordKeys(s.browserAnnotationMarkerIdsByPageId, [pageId])
        if (
          notes === s.browserAnnotationsByPageId &&
          markers === s.browserAnnotationMarkerIdsByPageId
        ) {
          return s
        }
        return { browserAnnotationsByPageId: notes, browserAnnotationMarkerIdsByPageId: markers }
      }),
    invalidateBrowserPageAnnotationGeometry: (pageId) =>
      set((s) => {
        const markers = omitRecordKeys(s.browserAnnotationMarkerIdsByPageId, [pageId])
        return markers === s.browserAnnotationMarkerIdsByPageId
          ? s
          : { browserAnnotationMarkerIdsByPageId: markers }
      }),
    removeDeliveredBrowserPageAnnotations: (pageId, deliveredAnnotations) =>
      set((s) => {
        const existing = s.browserAnnotationsByPageId[pageId] ?? []
        const delivered = new Set(deliveredAnnotations)
        const remaining = existing.filter((note) => !delivered.has(note))
        if (remaining.length === existing.length) {
          return s
        }
        const nextByPageId = { ...s.browserAnnotationsByPageId }
        if (remaining.length > 0) {
          nextByPageId[pageId] = remaining
        } else {
          delete nextByPageId[pageId]
        }
        return {
          browserAnnotationsByPageId: nextByPageId,
          browserAnnotationMarkerIdsByPageId: retainBrowserAnnotationMarkerIds(
            s.browserAnnotationMarkerIdsByPageId,
            pageId,
            remaining
          )
        }
      })
  }
}
