import { useCallback, useEffect, useRef } from 'react'
import type { BrowserGrabPayload } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserAnnotationDraft } from './pending-browser-annotation-card'

/** Identifies the picked element across picks, so reopening its comment card restores what was typed. */
export function browserAnnotationDraftKey(payload: BrowserGrabPayload): string {
  return `${payload.page.sanitizedUrl}\n${payload.target.selector}`
}

/**
 * Unsent comment text per element, kept while the annotate mode stays on.
 * Why a ref: drafts change on every keystroke and nothing renders from the map itself.
 */
export function useBrowserAnnotationDrafts(modeIsOn: boolean): {
  get: (key: string | null) => BrowserAnnotationDraft | undefined
  set: (key: string, draft: BrowserAnnotationDraft) => void
  remove: (key: string) => void
} {
  const draftsRef = useRef(new Map<string, BrowserAnnotationDraft>())

  // Leaving the mode is the point where unsent text is let go.
  useEffect(() => {
    if (!modeIsOn) {
      draftsRef.current.clear()
    }
  }, [modeIsOn])

  const get = useCallback(
    (key: string | null): BrowserAnnotationDraft | undefined =>
      key === null ? undefined : draftsRef.current.get(key),
    []
  )
  const set = useCallback((key: string, draft: BrowserAnnotationDraft): void => {
    if (draft.comment.trim()) {
      draftsRef.current.set(key, draft)
    } else {
      draftsRef.current.delete(key)
    }
  }, [])
  const remove = useCallback((key: string): void => {
    draftsRef.current.delete(key)
  }, [])
  return { get, set, remove }
}
