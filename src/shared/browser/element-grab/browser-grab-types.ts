// Share grab extraction contracts across main/preload/renderer, including redaction and budgets.

/** Page-level metadata captured at selection time. */
export type BrowserGrabPageContext = {
  sanitizedUrl: string
  title: string
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  devicePixelRatio: number
  capturedAt: string
  selectionId?: string
}

/** Accessibility metadata for the selected element. */
export type BrowserGrabAccessibility = {
  role: string | null
  accessibleName: string | null
  ariaLabel: string | null
  ariaLabelledBy: string | null
}

/** Curated subset of computed styles. */
export type BrowserGrabComputedStyles = {
  display: string
  position: string
  width: string
  height: string
  margin: string
  padding: string
  color: string
  backgroundColor: string
  border: string
  borderRadius: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  textAlign: string
  zIndex: string
}

/** Viewport-relative or page-relative rectangle in CSS pixels. */
export type BrowserGrabRect = {
  x: number
  y: number
  width: number
  height: number
}

/** The selected element's extracted data. */
export type BrowserGrabTarget = {
  tagName: string
  selector: string
  elementPath?: string
  fullPath?: string
  cssClasses?: string
  nearbyElements?: string[]
  selectedText?: string | null
  isFixed?: boolean
  reactComponents?: string | null
  sourceFile?: string | null
  textSnippet: string
  htmlSnippet: string
  attributes: Record<string, string>
  accessibility: BrowserGrabAccessibility
  rectViewport: BrowserGrabRect
  rectPage: BrowserGrabRect
  computedStyles: BrowserGrabComputedStyles
}

/** Screenshot attachment — always PNG, either a data URL or a temp file path. */
export type BrowserGrabScreenshot = {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
}

/** The full payload extracted from a browser grab selection. */
export type BrowserGrabPayload = {
  page: BrowserGrabPageContext
  target: BrowserGrabTarget
  nearbyText: string[]
  ancestorPath: string[]
  screenshot: BrowserGrabScreenshot | null
}

/** Persisted annotation payloads keep DOM context but drop transient screenshots. */
export type BrowserAnnotationPayload = Omit<BrowserGrabPayload, 'screenshot'> & {
  screenshot: null
}

export type GrabIntent = 'copy' | 'annotate'

/** Bare keys that copy (C) or screenshot (S) the hovered or picked element while Grab is on. */
export type BrowserGrabActionKey = 'c' | 's'

/** Bare keys that switch the annotate palette's tool: Annotate, Grab, Draw. */
export type BrowserAnnotateToolKey = 'a' | 'g' | 'd'

/** Bare keys a focused page forwards to the renderer while a grab op runs. */
export type BrowserGuestToolKey = BrowserGrabActionKey | BrowserAnnotateToolKey

/** Alt held over a focused page fades the palette so the element under it can be picked. */
export type BrowserGuestSeeThroughKey = 'alt-down' | 'alt-up'

/** Payload of the guest → renderer tool-key forward. */
export type BrowserGrabActionShortcutArgs = {
  browserPageId: string
  key: BrowserGuestToolKey | BrowserGuestSeeThroughKey
}

const BROWSER_GUEST_TOOL_KEYS: ReadonlySet<string> = new Set(['c', 's', 'a', 'g', 'd'])

export function isBrowserGuestToolKey(key: string): key is BrowserGuestToolKey {
  return BROWSER_GUEST_TOOL_KEYS.has(key)
}

/**
 * The tool letter a key press means. A Latin-script letter (QWERTY, AZERTY, Dvorak, Colemak, and accented letters
 * like ü or ą) is taken as typed, so the key labelled "C" copies wherever it sits and ü never means anything. Only a
 * letter from another script (Cyrillic, Greek…) falls back to the physical key so the keys still work there.
 * Dead keys and other non-letters return "", which matches no tool.
 */
export function browserGuestToolKeyFromEvent(event: { code?: string; key: string }): string {
  const typed = event.key
  if ([...typed].length !== 1 || !/\p{L}/u.test(typed)) {
    return ''
  }
  if (/\p{Script=Latin}/u.test(typed)) {
    return typed.toLowerCase()
  }
  const code = event.code ?? ''
  return code.startsWith('Key') && code.length === 4 ? code.slice(3).toLowerCase() : ''
}

export function isBrowserGrabActionKey(key: BrowserGuestToolKey): key is BrowserGrabActionKey {
  return key === 'c' || key === 's'
}

/** Why a grab operation was cancelled before the user selected an element. */
export type BrowserGrabCancelReason = 'user' | 'tab-inactive' | 'navigation' | 'evicted' | 'timeout'

/** Discriminated union for the result of a single grab operation. */
export type BrowserGrabResult =
  | { opId: string; kind: 'selected'; payload: BrowserGrabPayload }
  | { opId: string; kind: 'context-selected'; payload: BrowserGrabPayload }
  | { opId: string; kind: 'cancelled'; reason: BrowserGrabCancelReason }
  | { opId: string; kind: 'error'; reason: string }

export type BrowserSetGrabModeArgs = {
  paletteKeys?: boolean
  browserPageId: string
  requestId?: string
  enabled: boolean
}

/** Why a grab IPC call was rejected before the operation could start. */
export type BrowserGrabRejectReason =
  | 'not-ready'
  | 'not-authorized'
  | 'already-active'
  | 'injection-failed'

export type BrowserSetGrabModeResult =
  | { ok: true; clean?: boolean }
  | { ok: false; reason: BrowserGrabRejectReason }

/**
 * Where Orca's annotate palette and its hint cover a page, in Orca's pixels relative to the page frame's top-left,
 * with the frame's size so the page can convert to its own (zoomed) pixels. The picker keeps its label clear of it.
 */
export type BrowserGrabLabelAvoidArea = {
  x: number
  y: number
  width: number
  height: number
  frameWidth: number
  frameHeight: number
}

export type BrowserSetGrabLabelAvoidAreaArgs = {
  browserPageId: string
  area: BrowserGrabLabelAvoidArea | null
}

const GRAB_LABEL_AVOID_MAX_PX = 100_000

/** Validates a renderer-sent area: finite, bounded numbers and a non-empty frame, or null. Undefined means invalid. */
export function parseGrabLabelAvoidArea(
  value: unknown
): BrowserGrabLabelAvoidArea | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'object') {
    return undefined
  }
  const record: Record<string, unknown> = { ...value }
  const read = (key: keyof BrowserGrabLabelAvoidArea): number | undefined => {
    const n = record[key]
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= GRAB_LABEL_AVOID_MAX_PX
      ? n
      : undefined
  }
  const x = read('x')
  const y = read('y')
  const width = read('width')
  const height = read('height')
  const frameWidth = read('frameWidth')
  const frameHeight = read('frameHeight')
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    frameWidth === undefined ||
    frameHeight === undefined ||
    width < 0 ||
    height < 0 ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return undefined
  }
  return { x, y, width, height, frameWidth, frameHeight }
}

/** Is the element a held pick was made on still in the page (after a same-document route change)? */
export type BrowserGrabPickedElementPresentArgs = {
  browserPageId: string
  selectionId: string
  interactive?: boolean
}

export type BrowserAwaitGrabSelectionArgs = {
  browserPageId: string
  requestId?: string
  opId: string
}

export type BrowserCancelGrabArgs = {
  browserPageId: string
  requestId?: string
}

export type BrowserCaptureSelectionScreenshotArgs = {
  browserPageId: string
  selectionId?: string
  rect: BrowserGrabRect
}

export type BrowserCaptureSelectionScreenshotResult =
  | { ok: true; screenshot: BrowserGrabScreenshot }
  | { ok: false; reason: string }

export type BrowserExtractHoverArgs = {
  browserPageId: string
}

export type BrowserExtractHoverResult =
  | { ok: true; payload: BrowserGrabPayload }
  | { ok: false; reason: string }

export type BrowserAnnotationIntent = 'fix' | 'change' | 'question' | 'approve'

export type BrowserAnnotationPriority = 'blocking' | 'important' | 'suggestion'

export type BrowserPageAnnotation = {
  id: string
  browserPageId: string
  comment: string
  intent: BrowserAnnotationIntent
  priority: BrowserAnnotationPriority
  createdAt: string
  payload: BrowserAnnotationPayload
  /** Pasted images, saved on the worktree's host like a terminal image paste. */
  imagePaths?: string[]
}

// Payload budgets are enforced in guest and main.

export const GRAB_BUDGET = {
  textSnippetMaxLength: 200,
  nearbyTextEntryMaxLength: 200,
  nearbyTextMaxEntries: 10,
  htmlSnippetMaxLength: 4096,
  ancestorPathMaxEntries: 10,
  nearbyElementsMaxEntries: 6,
  nearbyElementMaxLength: 160,
  selectorMaxLength: 700,
  pathMaxLength: 900,
  cssClassesMaxLength: 500,
  selectedTextMaxLength: 500,
  sourceFileMaxLength: 500,
  reactComponentsMaxLength: 500,
  annotationCommentMaxLength: 2000,
  annotationsMaxPerPage: 20,
  /** Hard byte budget for screenshot PNG data URL before we omit the screenshot. */
  screenshotMaxBytes: 2 * 1024 * 1024
} as const

export function isBrowserAnnotationPageFull(annotationCount: number): boolean {
  return annotationCount >= GRAB_BUDGET.annotationsMaxPerPage
}

/** Only these attribute names are included in the payload by default. */
export const GRAB_SAFE_ATTRIBUTE_NAMES = new Set([
  'id',
  'class',
  'name',
  'type',
  'role',
  'href',
  'src',
  'alt',
  'title',
  'placeholder',
  'for',
  'action',
  'method'
])

/** Attribute names matching aria-* are always included. */
export function isAriaAttribute(name: string): boolean {
  return name.startsWith('aria-')
}

/** Redact OAuth/credential-shaped values, not broad words like code/state that match ordinary CSS classes and degrade extraction. */
export const GRAB_SECRET_PATTERNS = [
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'client_secret',
  'oauth_state',
  'x-amz-',
  'session_id',
  'sessionid',
  'csrf',
  'secret',
  'password',
  'passwd'
]
