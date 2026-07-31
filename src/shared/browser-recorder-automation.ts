// ---------------------------------------------------------------------------
// Browser action recorder — shared contract (main → preload → renderer)
//
// The main process records browser automation actions (click/type/goto/scroll/
// keypress/select/mouse…*) as they execute, together with the page they ran on
// and the DOM change they caused. Records stream to the renderer over IPC so
// the browser pane can fold them into its session log.
// ---------------------------------------------------------------------------

/** Compact page/DOM state captured before and after an action via in-page eval. */
export type BrowserRecorderDomFingerprint = {
  url: string
  title: string
  textLength: number
  interactive: number
  /** Joined label=value snapshot of form fields (password values excluded). */
  inputs: string
}

export type BrowserRecorderDomChangeKind = 'url' | 'title' | 'text' | 'inputs' | 'interactive'

/** What changed on the page as a result of an action. */
export type BrowserRecorderDomDiff = {
  urlChanged: boolean
  titleChanged: boolean
  textLengthDelta: number
  interactiveDelta: number
  inputsChanged: boolean
  changed: BrowserRecorderDomChangeKind[]
}

export type BrowserRecorderAutomationTargetKind = 'ref' | 'selector' | 'coordinate' | 'url' | 'none'

/** Where the action pointed: an element ref (@e5), a selector, x,y, or a URL. */
export type BrowserRecorderAutomationTarget = {
  kind: BrowserRecorderAutomationTargetKind
  value: string
}

export type BrowserRecorderAutomationParam = string | number | boolean | undefined

/** One executed browser automation action with its result. */
export type BrowserRecorderAutomationAction = {
  id: string
  /** RPC method name, e.g. 'browser.click'. */
  method: string
  target: BrowserRecorderAutomationTarget
  /** Sanitized params (secrets redacted, values capped). */
  params: Record<string, BrowserRecorderAutomationParam>
  /** Page state at action start. */
  page: { browserPageId: string; url: string; title: string }
  startedAt: string
  durationMs: number
  ok: boolean
  error: string | null
  urlAfter: string | null
  titleAfter: string | null
  domDiff: BrowserRecorderDomDiff | null
}

export const BROWSER_RECORDER_ACTION_CHANNEL = 'browser:recorder-action'
export const BROWSER_RECORDER_SET_CHANNEL = 'browser:setRecorderEnabled'

export const BROWSER_RECORDER_BUDGET = {
  /** Cap on the joined form-field snapshot kept per fingerprint. */
  fingerprintInputsMaxLength: 2000,
  /** Cap on a recorded param string value. */
  paramValueMaxLength: 200,
  /** Cap on the recorded error message. */
  errorMaxLength: 500
} as const
