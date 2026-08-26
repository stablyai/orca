import { useCallback, useRef, useState } from 'react'

import {
  BROWSER_RECORDER_DEFAULT_OPTIONS,
  type BrowserRecorderOptionKey,
  type BrowserRecorderOptions
} from '../../../../shared/browser-recorder-automation'
import {
  RECORDER_BUDGET,
  type BrowserRecorderStep,
  type BrowserRecorderStepDetail
} from './browser-recorder-types'

export type BrowserRecorderPageContext = {
  pageUrl: string
  pageTitle: string
}

export type BrowserRecorderHook = {
  recording: boolean
  steps: BrowserRecorderStep[]
  stepCount: number
  /** ISO timestamp of when the current recording session started. */
  startedAt: string | null
  /** Which streams the session records; toggles are pushed to main via IPC. */
  options: BrowserRecorderOptions
  setOption: (key: BrowserRecorderOptionKey, enabled: boolean) => void
  toggle: (page?: BrowserRecorderPageContext) => void
  clear: () => void
  /** Appends a step only while recording is active. */
  recordStep: (detail: BrowserRecorderStepDetail, page: BrowserRecorderPageContext) => void
}

function nextStepId(): string {
  return `browser-recorder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Chronological log of user operations inside one browser page pane. */
export function useBrowserRecorder(browserPageId: string): BrowserRecorderHook {
  const [recording, setRecording] = useState(false)
  const recordingRef = useRef(false)
  const [steps, setSteps] = useState<BrowserRecorderStep[]>([])
  const [startedAt, setStartedAt] = useState<string | null>(null)
  const [options, setOptions] = useState<BrowserRecorderOptions>({
    ...BROWSER_RECORDER_DEFAULT_OPTIONS
  })
  const pageIdRef = useRef(browserPageId)
  pageIdRef.current = browserPageId

  const setOption = useCallback(
    (key: BrowserRecorderOptionKey, enabled: boolean): void => {
      const next = { ...options, [key]: enabled }
      // Why: request details are a subset of requests — turning requests off
      // must not leave a dangling details-only state in the menu.
      if (key === 'requests' && !enabled) {
        next.requestDetails = false
      }
      setOptions(next)
      void window.api.browser.setRecorderOptions({ options: next }).catch(() => {})
    },
    [options]
  )

  const recordStep = useCallback(
    (detail: BrowserRecorderStepDetail, page: BrowserRecorderPageContext): void => {
      if (!recordingRef.current) {
        return
      }
      const step: BrowserRecorderStep = {
        id: nextStepId(),
        browserPageId: pageIdRef.current,
        createdAt: new Date().toISOString(),
        pageUrl: page.pageUrl,
        pageTitle: page.pageTitle,
        detail
      }
      setSteps((current) => [...current, step].slice(-RECORDER_BUDGET.maxStepsPerSession))
    },
    []
  )

  const toggle = useCallback(
    (page?: BrowserRecorderPageContext): void => {
      const next = !recordingRef.current
      recordingRef.current = next
      setRecording(next)
      if (next) {
        const now = new Date().toISOString()
        // Why: a fresh session starts from an empty log — retained steps would
        // mix two sessions under one startedAt.
        setSteps([])
        setStartedAt(now)
        // Why: the start marker makes the log self-describing — the reader sees
        // when the session began, and the page it began on.
        recordStep(
          { kind: 'recording-started' },
          { pageUrl: page?.pageUrl ?? '', pageTitle: page?.pageTitle ?? '' }
        )
      } else {
        setStartedAt(null)
      }
    },
    [recordStep]
  )

  const clear = useCallback((): void => {
    setSteps([])
    // Why: if the user clears mid-session, the next step becomes the new
    // baseline, so the markdown "Started" time stays meaningful.
    if (recordingRef.current) {
      setStartedAt(new Date().toISOString())
    }
  }, [])

  return {
    recording,
    steps,
    stepCount: steps.length,
    startedAt,
    options,
    setOption,
    toggle,
    clear,
    recordStep
  }
}
