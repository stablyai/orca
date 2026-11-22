import {
  GRAB_BUDGET,
  type BrowserPageAnnotation
} from '../../../../../../shared/browser/element-grab/browser-grab-types'

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

/** A close drops the notes it submitted; notes added while its frame was in flight stay keyed by page. */
export function dropSubmittedBrowserPageAnnotations(
  nextAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>,
  nextMarkerIdsByPageId: Record<string, string[]>,
  pageId: string,
  submittedNoteIds: ReadonlySet<string> | null
): Record<string, string[]> {
  const kept = submittedNoteIds
    ? (nextAnnotationsByPageId[pageId] ?? []).filter((note) => !submittedNoteIds.has(note.id))
    : []
  if (kept.length > 0) {
    nextAnnotationsByPageId[pageId] = kept
    return retainBrowserAnnotationMarkerIds(nextMarkerIdsByPageId, pageId, kept)
  }
  delete nextAnnotationsByPageId[pageId]
  delete nextMarkerIdsByPageId[pageId]
  return nextMarkerIdsByPageId
}

/** Closing a browser tab discards the notes its pages hold unsent. */
export function hasUnsentBrowserNotes(
  state: {
    browserPagesByWorkspace: Record<string, readonly { id: string }[]>
    browserAnnotationsByPageId: Record<string, readonly BrowserPageAnnotation[]>
  },
  browserWorkspaceId: string
): boolean {
  return (state.browserPagesByWorkspace[browserWorkspaceId] ?? []).some(
    (page) => (state.browserAnnotationsByPageId[page.id]?.length ?? 0) > 0
  )
}
