import type { MutableRefObject } from 'react'
import type {
  BrowserAnnotationIntent,
  BrowserGrabPayload
} from '../../../../../shared/browser-grab-types'
import type { BrowserRecorderStepDetail } from '../browser-recorder-types'
import type { BrowserRecorderPageContext } from '../useBrowserRecorder'
import { summarizeBrowserGrabTarget } from '../browser-recorder-types'

/** Recorder integration surface the grab/annotate flows need. */
export type BrowserGrabRecorder = {
  recordingRef: MutableRefObject<boolean>
  recordStep: (detail: BrowserRecorderStepDetail, page: BrowserRecorderPageContext) => void
}

/** Logs a picked element (element-selected step) into an active session. */
export function logGrabElementSelected(
  recorder: BrowserGrabRecorder | undefined,
  payload: BrowserGrabPayload
): void {
  recorder?.recordStep(
    { kind: 'element-selected', element: summarizeBrowserGrabTarget(payload.target) },
    { pageUrl: payload.page.sanitizedUrl, pageTitle: payload.page.title }
  )
}

/** Logs a new annotation (annotation-added step) into an active session. */
export function logGrabAnnotationAdded(
  recorder: BrowserGrabRecorder | undefined,
  payload: BrowserGrabPayload,
  comment: string,
  intent: BrowserAnnotationIntent
): void {
  recorder?.recordStep(
    {
      kind: 'annotation-added',
      element: summarizeBrowserGrabTarget(payload.target),
      comment,
      intent
    },
    { pageUrl: payload.page.sanitizedUrl, pageTitle: payload.page.title }
  )
}
