import type { IDisposable } from '@xterm/xterm'

// Why: iOS/iPadOS composes Hangul with a hardware keyboard by rewriting text it
// has already committed — `deleteContentBackward` then `insertText` with the
// updated syllable — and fires no composition events at all. xterm cannot see
// that: it consumes the printable keydown, so the system's input logic never
// runs and the raw compatibility jamo in `event.key` reaches the PTY instead.
// Letting the keydown through and mirroring the field's edits keeps composition
// working. The diff is taken against the field rather than the edit events so a
// stray delete cannot desync the PTY.

const TERMINAL_DEL_BYTE = '\x7f'

/**
 * Represents a text edit step computed by diffing the field against sent text.
 */
export type TerminalIosTextEditStep = {
  /** The number of code points to erase from the PTY. */
  readonly eraseCount: number
  /** The text to append to the PTY after erasing. */
  readonly appendText: string
}

/**
 * Diffs text already sent to the PTY against the field's current value, as
 * "erase this many code points, then append this".
 *
 * Erasures are counted in code points, not UTF-16 units, because one Hangul
 * syllable is one code point and one terminal DEL.
 */
export function computeTerminalIosTextEditStep(
  sentText: string,
  fieldText: string
): TerminalIosTextEditStep {
  const sent = Array.from(sentText)
  const field = Array.from(fieldText)
  let commonPrefixLength = 0
  while (
    commonPrefixLength < sent.length &&
    commonPrefixLength < field.length &&
    sent[commonPrefixLength] === field[commonPrefixLength]
  ) {
    commonPrefixLength += 1
  }
  return {
    eraseCount: sent.length - commonPrefixLength,
    appendText: field.slice(commonPrefixLength).join('')
  }
}

/**
 * Builds the raw payload string (DEL bytes + appendText) for a text edit step.
 */
export function buildTerminalIosTextEditPayload(step: TerminalIosTextEditStep): string {
  return TERMINAL_DEL_BYTE.repeat(step.eraseCount) + step.appendText
}

/**
 * Controller for the terminal iOS text edit mirror.
 */
export type TerminalIosTextEditMirror = IDisposable & {
  /**
   * Drops mirrored state once anything else writes to the PTY, so the next edit
   * diffs against an empty field instead of replaying text the PTY already has.
   */
  reset: () => void
  /** True only while this mirror is the one writing to the PTY. */
  isMirroring: () => boolean
}

const NO_OP_MIRROR: TerminalIosTextEditMirror = {
  reset: () => undefined,
  isMirroring: () => false,
  dispose: () => undefined
}

function findHelperTextarea(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
}

function asHelperTextarea(target: EventTarget | null): HTMLTextAreaElement | null {
  if (!(target instanceof HTMLTextAreaElement)) {
    return null
  }
  return target.classList.contains('xterm-helper-textarea') ? target : null
}

/**
 * Installs an edit mirror on the helper textarea inside the terminal element.
 *
 * Captures input events on iOS/iPadOS WebKit to diff text already sent against the field's
 * current value, allowing hardware-keyboard Hangul input to reach the PTY.
 */
export function installTerminalIosTextEditMirror(args: {
  terminalElement: HTMLElement | null | undefined
  sendInput: (data: string) => void
}): TerminalIosTextEditMirror {
  if (!args.terminalElement) {
    return NO_OP_MIRROR
  }

  const terminalElement = args.terminalElement
  let sentText = ''
  let composing = false
  let mirroring = false

  const reset = (): void => {
    sentText = ''
    const textarea = findHelperTextarea(terminalElement)
    if (textarea) {
      textarea.value = ''
    }
  }

  // Why: some iOS input sources (the on-screen keyboard, Japanese and Chinese
  // IMEs) do run a composition session. xterm's CompositionHelper already
  // handles those correctly, and it commits by reading the field itself — so
  // the mirror must stand aside for the whole session or the text is sent
  // twice. Only after the session end clears `sentText`; the field belongs to xterm.
  // We defer clearing `composing` via queueMicrotask so xterm can complete its
  // deferred composition commit before the mirror resumes.
  const beginComposition = (): void => {
    composing = true
  }
  const endComposition = (): void => {
    queueMicrotask(() => {
      composing = false
      sentText = ''
    })
  }

  const mirrorTextEdit = (event: Event): void => {
    if (composing) {
      return
    }
    const textarea = asHelperTextarea(event.target)
    if (!textarea) {
      return
    }
    const step = computeTerminalIosTextEditStep(sentText, textarea.value)
    sentText = textarea.value
    // Why: the field keeps its text so the system can rewrite the trailing
    // syllable, so xterm must not also read it as fresh input.
    event.stopImmediatePropagation()
    const payload = buildTerminalIosTextEditPayload(step)
    if (!payload) {
      return
    }
    mirroring = true
    try {
      args.sendInput(payload)
    } finally {
      mirroring = false
    }
  }

  const resetOnHelperTextareaBlur = (event: Event): void => {
    if (asHelperTextarea(event.target)) {
      reset()
    }
  }

  terminalElement.addEventListener('input', mirrorTextEdit, true)
  terminalElement.addEventListener('compositionstart', beginComposition, true)
  terminalElement.addEventListener('compositionend', endComposition, true)
  terminalElement.addEventListener('blur', resetOnHelperTextareaBlur, true)

  return {
    reset,
    isMirroring: () => mirroring,
    dispose: () => {
      terminalElement.removeEventListener('input', mirrorTextEdit, true)
      terminalElement.removeEventListener('compositionstart', beginComposition, true)
      terminalElement.removeEventListener('compositionend', endComposition, true)
      terminalElement.removeEventListener('blur', resetOnHelperTextareaBlur, true)
    }
  }
}
