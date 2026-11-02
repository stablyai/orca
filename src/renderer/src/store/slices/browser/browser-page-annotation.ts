import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'

export function sanitizeBrowserPageAnnotation(
  annotation: BrowserPageAnnotation
): BrowserPageAnnotation {
  return {
    ...annotation,
    comment:
      annotation.comment.length > GRAB_BUDGET.annotationCommentMaxLength
        ? annotation.comment.slice(0, GRAB_BUDGET.annotationCommentMaxLength)
        : annotation.comment,
    payload: {
      ...annotation.payload,
      // Saved notes must not retain transient screenshot bytes.
      screenshot: null
    }
  }
}

export function retainBrowserAnnotationMarkerIds(
  markersByPageId: Record<string, string[]>,
  pageId: string,
  annotations: readonly BrowserPageAnnotation[],
  addedId?: string
): Record<string, string[]> {
  const existingIds = markersByPageId[pageId] ?? []
  const retainedIds = new Set(annotations.map((annotation) => annotation.id))
  const nextIds = [...new Set(addedId ? [...existingIds, addedId] : existingIds)].filter((id) =>
    retainedIds.has(id)
  )
  if (nextIds.length === existingIds.length && nextIds.every((id, i) => id === existingIds[i])) {
    return markersByPageId
  }
  const nextByPageId = { ...markersByPageId }
  if (nextIds.length > 0) {
    nextByPageId[pageId] = nextIds
  } else {
    delete nextByPageId[pageId]
  }
  return nextByPageId
}
