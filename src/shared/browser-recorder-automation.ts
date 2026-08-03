// ---------------------------------------------------------------------------
// Browser action recorder — shared contract (main → preload → renderer)
//
// The main process records browser automation actions (click/type/goto/scroll/
// keypress/select/mouse…*) as they execute, together with the page they ran on
// and the DOM change they caused. While a recording session is active it also
// observes manual page interactions (clicks/keys/scroll) and page console
// output, and summarizes network traffic on session stop. Records stream to
// the renderer over IPC so the browser pane can fold them into its session log.
// ---------------------------------------------------------------------------

/** Compact page/DOM state captured before and after an action via in-page eval. */
export type BrowserRecorderDomFingerprint = {
  url: string
  title: string
  textLength: number
  interactive: number
  /** Structured form-field snapshot (password values excluded, capped). */
  inputsDetail: BrowserRecorderInputState[]
}

export type BrowserRecorderInputState = {
  label: string
  value: string
}

export type BrowserRecorderDomChangeKind = 'url' | 'title' | 'text' | 'inputs' | 'interactive'

/** One form field whose value changed as a result of an action. */
export type BrowserRecorderInputChange = {
  label: string
  before: string
  after: string
}

/** What changed on the page as a result of an action. */
export type BrowserRecorderDomDiff = {
  urlChanged: boolean
  titleChanged: boolean
  textLengthDelta: number
  interactiveDelta: number
  inputsChanged: boolean
  /** Only fields whose value changed (capped). */
  inputChanges: BrowserRecorderInputChange[]
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

export type BrowserRecorderInteractionKind = 'click' | 'keydown' | 'type' | 'scroll' | 'hover'

/** A manual page interaction observed while recording (in-page capture script). */
export type BrowserRecorderInteraction = {
  id: string
  kind: BrowserRecorderInteractionKind
  page: { browserPageId: string; url: string; title: string }
  startedAt: string
  /** click */
  x?: number
  y?: number
  /** Clicked/hovered/typed-into element: '#id', 'button.primary', or tag name. */
  target?: string
  tagName?: string
  /** keydown (special key) or type (coalesced burst) */
  key?: string
  /** Coalesced typing burst text (kind 'type'). */
  text?: string
  /** scroll */
  scrollX?: number
  scrollY?: number
}

/** One page network request observed while recording (fetch/XHR hook). */
export type BrowserRecorderNetworkRequest = {
  id: string
  page: { browserPageId: string; url: string; title: string }
  startedAt: string
  method: string
  /** Request URL (query secrets redacted). */
  url: string
  /** Form-encoded body with secret-shaped values redacted (capped). */
  postData: string | null
  status: number | null
  durationMs: number | null
  /** DOM change kinds observed after the response landed. */
  screenChanged: BrowserRecorderDomChangeKind[]
}

export type BrowserRecorderConsoleLevel = 'log' | 'warning' | 'error' | 'debug'

/** One page console message observed while recording (repeats coalesced). */
export type BrowserRecorderConsoleEntry = {
  id: string
  level: BrowserRecorderConsoleLevel
  message: string
  source: string
  lineNumber: number
  /** How many consecutive identical messages this entry represents. */
  repeatCount: number
  page: { browserPageId: string; url: string; title: string }
  startedAt: string
}

export type BrowserRecorderNetworkStatusBucket = {
  status: number
  count: number
}

/** Traffic summary computed from the page network log when recording stops. */
export type BrowserRecorderNetworkSummary = {
  id: string
  page: { browserPageId: string; url: string; title: string }
  startedAt: string
  total: number
  failed: number
  totalBytes: number
  byStatus: BrowserRecorderNetworkStatusBucket[]
}

/** Everything the main process streams into the browser pane session log. */
export type BrowserRecorderStreamEvent =
  | { kind: 'action'; action: BrowserRecorderAutomationAction }
  | { kind: 'interaction'; interaction: BrowserRecorderInteraction }
  | { kind: 'console'; entry: BrowserRecorderConsoleEntry }
  | { kind: 'network-request'; request: BrowserRecorderNetworkRequest }
  | { kind: 'network-summary'; summary: BrowserRecorderNetworkSummary }

export const BROWSER_RECORDER_ACTION_CHANNEL = 'browser:recorder-action'
export const BROWSER_RECORDER_SET_CHANNEL = 'browser:setRecorderEnabled'

/**
 * Prefix used by the in-page interaction capture script. Tagged console.debug
 * messages are interactions; every other page console message is a console
 * entry. The tag itself is unique enough that a real page log line starting
 * with it would be indistinguishable — acceptable for a debug-only recorder.
 */
export const BROWSER_RECORDER_INTERACTION_TAG = '__orca_recorder__'

export const BROWSER_RECORDER_BUDGET = {
  /** Cap on form fields kept per fingerprint. */
  fingerprintInputsMaxFields: 50,
  /** Cap on a single form-field value kept in a fingerprint. */
  inputValueMaxLength: 60,
  /** Cap on changed-field entries kept in a DOM diff. */
  inputChangesMaxEntries: 20,
  /** Cap on a recorded param string value. */
  paramValueMaxLength: 200,
  /** Cap on the recorded error message. */
  errorMaxLength: 500,
  /** Cap on manual interaction records per session (oldest dropped). */
  interactionMaxPerSession: 400,
  /** Cap on console entries per session (oldest dropped). */
  consoleMaxPerSession: 120,
  /** Cap on a console message text kept in an entry. */
  consoleMessageMaxLength: 300,
  /** Cap on network request records per session (oldest dropped). */
  networkRequestMaxPerSession: 300,
  /** Cap on a request body kept in an entry. */
  requestBodyMaxLength: 300
} as const
