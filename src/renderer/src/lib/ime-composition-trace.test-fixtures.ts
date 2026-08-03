// Recorded-trace harness for IME tests. See the IME rules in AGENTS.md.
//
// Synthetic keystrokes cannot produce a real composition: KeyboardEvents dispatched
// through CDP bypass the OS input-method layer entirely. The only faithful way to
// test IME behavior is to replay an event sequence captured from a real engine,
// stamping the observed target state before each event so the code under test sees
// byte-for-byte what the browser produced.

export type ImeTracePlatform = 'darwin' | 'linux' | 'win32'

export type ImeTraceEnvironment = {
  platform: ImeTracePlatform
  browser: 'chromium' | 'gecko' | 'webkit'
  /** Engine name for humans only. No production code may branch on it. */
  engine: string
}

/** The input element's observed state at the instant an event fired. */
export type ImeTraceTargetState = {
  value: string
  selectionStart: number
  selectionEnd: number
  /** Absent means 'none'. Without it a preedit range can only ever be a caret. */
  selectionDirection?: 'backward' | 'forward' | 'none'
}

type ImeTraceEventBase = { state: ImeTraceTargetState }

export type ImeTraceKeyEvent = ImeTraceEventBase & {
  type: 'keydown' | 'keypress' | 'keyup'
  key: string
  code: string
  keyCode: number
  isComposing: boolean
  /** macOS press-and-hold drives its accent panel off this; absent means false. */
  repeat?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

export type ImeTraceCompositionEvent = ImeTraceEventBase & {
  type: 'compositionstart' | 'compositionupdate' | 'compositionend'
  data: string
}

export type ImeTraceInputEvent = ImeTraceEventBase & {
  type: 'beforeinput' | 'input'
  inputType: string
  data: string | null
  /** Safari reports `undefined` rather than `false`; the distinction is load-bearing. */
  isComposing: boolean | undefined
}

export type ImeTraceEvent = ImeTraceCompositionEvent | ImeTraceInputEvent | ImeTraceKeyEvent

/**
 * `recorded` traces were captured from a real engine and are authoritative.
 * `derived` traces were reconstructed from a documented event ordering; they pin
 * current behavior but cannot prove the ordering is what the engine really emits.
 * A fix justified only by a `derived` trace is unverified — say so in the PR.
 */
export type ImeTraceProvenance = 'derived' | 'recorded'

export type ImeCompositionTrace = {
  name: string
  provenance: ImeTraceProvenance
  /** What the human did, where the trace came from, and the issue it belongs to. */
  origin: string
  env: ImeTraceEnvironment
  initial: ImeTraceTargetState
  events: ImeTraceEvent[]
  final: ImeTraceTargetState
  /** Text the surface under test must ultimately commit. Empty means "commit nothing". */
  committed: string
}

export const EMPTY_IME_TRACE_STATE: ImeTraceTargetState = {
  value: '',
  selectionStart: 0,
  selectionEnd: 0
}

function applyLegacyKeyCode(event: KeyboardEvent, keyCode: number): void {
  if (event.keyCode === keyCode) {
    return
  }
  // happy-dom ignores the legacy keyCode init member.
  Object.defineProperty(event, 'keyCode', { configurable: true, value: keyCode })
  Object.defineProperty(event, 'which', { configurable: true, value: keyCode })
}

function applyIsComposing(event: Event, isComposing: boolean | undefined): void {
  if ((event as { isComposing?: boolean }).isComposing === isComposing) {
    return
  }
  // Testing libraries cannot set isComposing any other way. `undefined` is a real
  // recorded value, not a missing one: the constructor coerces it to false, which
  // is the one thing a Safari trace exists to tell apart.
  Object.defineProperty(event, 'isComposing', { configurable: true, value: isComposing })
}

export function createImeTraceKeyboardEvent(event: ImeTraceKeyEvent): KeyboardEvent {
  const created = new KeyboardEvent(event.type, {
    altKey: event.altKey ?? false,
    bubbles: true,
    cancelable: true,
    code: event.code,
    ctrlKey: event.ctrlKey ?? false,
    isComposing: event.isComposing,
    key: event.key,
    keyCode: event.keyCode,
    metaKey: event.metaKey ?? false,
    repeat: event.repeat ?? false,
    shiftKey: event.shiftKey ?? false
  })
  applyLegacyKeyCode(created, event.keyCode)
  applyIsComposing(created, event.isComposing)
  return created
}

export function createImeTraceCompositionEvent(event: ImeTraceCompositionEvent): CompositionEvent {
  return new CompositionEvent(event.type, { bubbles: true, cancelable: true, data: event.data })
}

export function createImeTraceInputEvent(event: ImeTraceInputEvent): InputEvent {
  const created = new InputEvent(event.type, {
    bubbles: true,
    cancelable: event.type === 'beforeinput',
    composed: true,
    data: event.data,
    inputType: event.inputType,
    isComposing: event.isComposing ?? false
  })
  applyIsComposing(created, event.isComposing)
  return created
}

export function createImeTraceEvent(event: ImeTraceEvent): Event {
  switch (event.type) {
    case 'beforeinput':
    case 'input':
      return createImeTraceInputEvent(event)
    case 'keydown':
    case 'keypress':
    case 'keyup':
      return createImeTraceKeyboardEvent(event)
    case 'compositionstart':
    case 'compositionupdate':
    case 'compositionend':
      return createImeTraceCompositionEvent(event)
  }
}

export type ImeTraceReplayViolation = {
  eventType: string
  reason: string
}

export type ImeTraceReplay = {
  /** Invariant breaches observed during replay. A correct implementation leaves this empty. */
  violations: ImeTraceReplayViolation[]
  /** Every event dispatched, in order, for ordering assertions. */
  dispatched: Event[]
}

export type ImeTraceReplayOptions = {
  /** Runs after each event so tests can observe intermediate state. */
  onEvent?: (event: Event, index: number) => void
  /** Yields between events to preserve async ordering. Defaults to a microtask. */
  yieldBetweenEvents?: () => Promise<void>
}

function readTargetState(target: HTMLTextAreaElement | HTMLInputElement): ImeTraceTargetState {
  return {
    selectionDirection: target.selectionDirection ?? 'none',
    selectionEnd: target.selectionEnd ?? 0,
    selectionStart: target.selectionStart ?? 0,
    value: target.value
  }
}

function stampTargetState(
  target: HTMLTextAreaElement | HTMLInputElement,
  state: ImeTraceTargetState
): void {
  target.value = state.value
  target.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection)
}

/**
 * Replays a recorded trace against a real input element.
 *
 * The recorded state is stamped in *before* each event fires, so the code under test
 * sees the browser's actual buffer rather than a simulation of it.
 */
export async function replayImeCompositionTrace(
  target: HTMLTextAreaElement | HTMLInputElement,
  trace: ImeCompositionTrace,
  options: ImeTraceReplayOptions = {}
): Promise<ImeTraceReplay> {
  const violations: ImeTraceReplayViolation[] = []
  const dispatched: Event[] = []
  const yieldBetweenEvents = options.yieldBetweenEvents ?? (() => Promise.resolve())

  stampTargetState(target, trace.initial)

  for (const [index, event] of trace.events.entries()) {
    stampTargetState(target, event.state)
    const stamped = readTargetState(target)
    const created = createImeTraceEvent(event)

    target.dispatchEvent(created)
    dispatched.push(created)

    const after = readTargetState(target)
    if (event.type === 'compositionstart' && after.value !== stamped.value) {
      // Clearing the textarea here makes the browser skip compositionend entirely.
      violations.push({
        eventType: event.type,
        reason: `wrote ${JSON.stringify(after.value)} to the target during compositionstart`
      })
    }

    options.onEvent?.(created, index)
    await yieldBetweenEvents()
  }

  return { dispatched, violations }
}

export function createImeTraceTextarea(document: Document): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

/** One committed chunk, positioned by range rather than by diffing the buffer. */
export type ImeCommit = {
  text: string
  /** Preedit characters immediately before the caret that this commit replaces. */
  replacePrevCharCnt?: number
}

/**
 * Splices commits into the trace's initial text at the caret and returns the resulting
 * state. Commits replace rather than only append: Hangul input commits each jamo and
 * then re-commits the composed syllable over it, so most events carry
 * `replacePrevCharCnt: 1`, and an implementation that appended those instead would
 * produce the right characters in the wrong order.
 */
export function interpretImeCommits(
  initial: ImeTraceTargetState,
  commits: readonly ImeCommit[]
): ImeTraceTargetState {
  let value = initial.value
  let caret = initial.selectionStart

  for (const commit of commits) {
    const replaceFrom = Math.max(0, caret - (commit.replacePrevCharCnt ?? 0))
    value = value.slice(0, replaceFrom) + commit.text + value.slice(caret)
    caret = replaceFrom + commit.text.length
  }

  return { selectionEnd: caret, selectionStart: caret, value }
}

/**
 * Reads the commits a correct surface must derive from this trace, using only event
 * `data` — never a diff of two buffer observations, per the rule in AGENTS.md.
 *
 * Two shapes deliver a commit. Most engines follow `compositionend` with an
 * `insertText` carrying the committed text. ibus-hangul often does not: it leaves the
 * text in the buffer from the last `insertCompositionText` and `compositionend` is the
 * only carrier. Taking both without this de-duplication would double every commit.
 */
export function extractImeCommitsFromTrace(trace: ImeCompositionTrace): ImeCommit[] {
  const commits: ImeCommit[] = []

  for (const [index, event] of trace.events.entries()) {
    if (event.type === 'input' && event.inputType === 'insertText' && event.data !== null) {
      commits.push({ text: event.data })
      continue
    }
    if (event.type !== 'compositionend' || event.data === '') {
      continue
    }
    // Only the window before the next composition or plain keystroke counts: a later
    // insertText from ordinary typing must not cancel a retained commit.
    const followUp = trace.events
      .slice(index + 1)
      .find((later) => later.type === 'input' || later.type === 'keydown')
    const deliveredByInsertText = followUp?.type === 'input' && followUp.inputType === 'insertText'
    if (!deliveredByInsertText) {
      commits.push({ text: event.data })
    }
  }

  return commits
}
