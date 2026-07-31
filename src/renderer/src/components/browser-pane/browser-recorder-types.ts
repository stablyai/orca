// ---------------------------------------------------------------------------
// Browser action recorder — renderer-only types
//
// The recorder captures a chronological log of user operations inside a local
// browser pane: element selections (grab), annotations, and page navigations.
// Every step stores the page it happened on, so the log stays readable even
// when the user navigates mid-session.
// ---------------------------------------------------------------------------

import type {
  BrowserAnnotationIntent,
  BrowserGrabRect,
  BrowserGrabTarget
} from '../../../../shared/browser-grab-types'

/** Compact element snapshot kept in the log (no screenshots, no full payloads). */
export type BrowserRecorderElementSummary = {
  tagName: string
  selector: string
  elementPath?: string
  cssClasses?: string
  accessibleName?: string | null
  textSnippet: string
  rectViewport: BrowserGrabRect
}

export type BrowserRecorderStepKind =
  | 'recording-started'
  | 'navigation'
  | 'element-selected'
  | 'annotation-added'

export type BrowserRecorderStepDetail =
  | { kind: 'recording-started' }
  | { kind: 'navigation'; fromUrl: string; toUrl: string }
  | { kind: 'element-selected'; element: BrowserRecorderElementSummary }
  | {
      kind: 'annotation-added'
      element: BrowserRecorderElementSummary
      comment: string
      intent: BrowserAnnotationIntent
    }

export type BrowserRecorderStep = {
  id: string
  browserPageId: string
  createdAt: string
  /** URL of the page the step happened on. */
  pageUrl: string
  pageTitle: string
  detail: BrowserRecorderStepDetail
}

export const RECORDER_BUDGET = {
  /** Hard cap on steps kept in a single recording session (oldest dropped). */
  maxStepsPerSession: 200
} as const

/** Maps a grabbed element onto the compact log summary. */
export function summarizeBrowserGrabTarget(
  target: BrowserGrabTarget
): BrowserRecorderElementSummary {
  return {
    tagName: target.tagName,
    selector: target.selector,
    elementPath: target.elementPath,
    cssClasses: target.cssClasses,
    accessibleName: target.accessibility.accessibleName,
    textSnippet: target.textSnippet,
    rectViewport: target.rectViewport
  }
}
