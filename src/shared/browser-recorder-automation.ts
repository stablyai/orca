// Browser action recorder — shared contract (main → preload → renderer).

/** Compact page/DOM state captured before and after an action via in-page eval. */
export type BrowserRecorderDomFingerprint = {
  url: string
  title: string
  textLength: number
  interactive: number
  /** Structured form-field snapshot (password values excluded, capped). */
  inputsDetail: BrowserRecorderInputState[]
  /** Visible body text snapshot (capped) — enables a real DOM text diff. */
  bodyText?: string
}

export type BrowserRecorderInputState = {
  /** Stable identity across fingerprint snapshots (CSS path/id or index). */
  key: string
  /** Display label (id, name, aria-label, type, or tag name). */
  label: string
  value: string
}

export type BrowserRecorderDomChangeKind = 'url' | 'title' | 'text' | 'inputs' | 'interactive'

/** One form field whose value changed as a result of an action. */
export type BrowserRecorderInputChange = {
  /** Stable identity from the fingerprint state (see BrowserRecorderInputState). */
  key: string
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
  /** Visible-text before/after snippets around the changed region (capped). */
  textChange: { before: string; after: string } | null
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

export type BrowserRecorderInteractionKind =
  | 'click'
  | 'keydown'
  | 'type'
  | 'scroll'
  | 'hover'
  | 'change'
  | 'clipboard'
  | 'ws'
  | 'storage'
  | 'select_text'

/** Element properties captured for interacted elements (selector, classes, …). */
export type BrowserRecorderElementProps = {
  /** Full CSS path, e.g. body > form#urunForm > div.row > button.btn-save. */
  selector: string
  tagName: string
  /** Up to 5 classes. */
  classes: string[]
  /** Visible text, truncated. */
  text: string
  /** Notable computed styles as 'prop:value' (display, visibility, position). */
  styles: string[]
}

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
  /** Element props for the interacted element (iframes included). */
  element?: BrowserRecorderElementProps
  /** keydown (special key) or type (coalesced burst) */
  key?: string
  /** Coalesced typing burst text (kind 'type'). */
  text?: string
  /** select/checkbox/input real value after a change (kind 'change'). */
  value?: string
  /** clipboard copy/paste/cut (kind 'clipboard'). */
  clipboardAction?: 'copy' | 'paste' | 'cut'
  /** clipboard text payload (kind 'clipboard'), secrets masked. */
  clipboardText?: string
  /** WebSocket frame text (kind 'ws'). */
  wsText?: string
  /** storage key (kind 'storage'). */
  storageKey?: string
  /** storage value (kind 'storage'), secret keys masked. */
  storageValue?: string
  /** selected text (kind 'select_text'). */
  selectText?: string
  /** scroll */
  scrollX?: number
  scrollY?: number
}

/** One page network request observed while recording (fetch/XHR/frame hook). */
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
  /** App function that initiated the request, e.g. 'stokKaydet@stok.php:142'. */
  origin: string | null
  /** Id of the interaction/action that triggered this request. */
  triggeredBy: string | null
  /** 'fetch' | 'xhr' | 'frame' (iframe navigation/form submit). */
  kind: 'fetch' | 'xhr' | 'frame'
  /** DOM change kinds observed after the response landed. */
  screenChanged: BrowserRecorderDomChangeKind[]
  /** Response body text, secret values redacted; null when not captured. */
  response?: string | null
  /** Full response size in bytes/chars before truncation (0 = unknown). */
  responseSize?: number
  /** True when the response was truncated to fit the log budget. */
  responseTruncated?: boolean
  /** 'html' when an HTML response was schematized into visible text + controls. */
  responseSchema?: 'html' | 'text'
}

export type BrowserRecorderConsoleLevel = 'log' | 'warning' | 'error' | 'debug'

/** One page console message observed while recording (repeats coalesced). */
export type BrowserRecorderConsoleEntry = {
  id: string
  level: BrowserRecorderConsoleLevel
  message: string
  source: string
  lineNumber: number
  /** First stack frame (fn@file:line) when the browser provided one. */
  stack?: string
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
  consoleMaxPerSession: 400,
  /** Cap on a console message text kept in an entry. */
  consoleMessageMaxLength: 300,
  /** Cap on network request records per session (oldest dropped). */
  networkRequestMaxPerSession: 300,
  /** Cap on a request body kept in an entry. */
  requestBodyMaxLength: 600,
  /** Cap on a response body kept in an entry (larger responses are truncated). */
  responseMaxLength: 8000,
  /**
   * Head slice kept from a truncated response — the tail slice is
   * responseMaxLength minus this, so large HTML list responses keep both the
   * header markup and the trailing data rows.
   */
  responseHeadMaxLength: 5800,
  /** Cap on the visible body-text snapshot kept in a fingerprint. */
  bodyTextMaxLength: 4000,
  /** Cap on each side of the DOM text-change snippet in a diff. */
  textChangeMaxLength: 400,
  /** Cap on a raw tagged console line accepted for parsing (DoS guard). */
  taggedLineMaxLength: 256 * 1024,
  /** Cap on classes kept per element props. */
  elementClassesMax: 5,
  /** Cap on element visible text kept in props. */
  elementTextMaxLength: 60,
  /** Cap on the request origin string ('fn@file:line'). */
  originMaxLength: 120
} as const
