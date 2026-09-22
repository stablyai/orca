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
      // Why: annotations persist to disk; null the transient screenshot to avoid retaining megabytes per note.
      screenshot: null
    }
  }
}
