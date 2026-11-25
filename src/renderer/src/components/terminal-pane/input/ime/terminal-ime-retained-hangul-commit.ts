import {
  KITTY_REPORT_EVENT_TYPES,
  kittyReportsAllKeysAsEscapeCodes
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'

// Hangul jamo blocks plus precomposed syllables: text a Korean input method may later rebuild in place.
const HANGUL_TEXT = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿ﾠ-ￜ]/u

type RetainedRange = {
  textarea: HTMLTextAreaElement
  start: number
  end: number
  text: string
}

/**
 * macOS 2-Set can commit a lone jamo as plain text and then rebuild it in place (ㅇ + ㅏ → 아) by
 * replacing that committed range (#9738). The forwarder has already sent the jamo, so keep it in the
 * field for the replacement to land, and erase it from the PTY when the input method replaces it.
 */
export type TerminalImeRetainedHangulCommit = {
  /** Returns true when the commit stays in the field instead of being cleared. */
  retain: (textarea: HTMLTextAreaElement, committedText: string) => boolean
  dispose: () => void
}

// Only these replacements are forwarded to the PTY afterwards; erasing for any other edit would lose text.
const FORWARDED_REPLACEMENT_INPUT_TYPES = new Set(['insertText', 'insertCompositionText'])
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn'])

function encodeBackspace(kittyKeyboardFlags: number): string {
  if (!kittyReportsAllKeysAsEscapeCodes(kittyKeyboardFlags)) {
    return '\x7f'
  }
  return (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) !== 0
    ? '\x1b[127u\x1b[127;1:3u'
    : '\x1b[127u'
}

function isIntact(range: RetainedRange): boolean {
  return range.textarea.value.slice(range.start, range.end) === range.text
}

export function installTerminalImeRetainedHangulCommit(args: {
  terminalElement: HTMLElement
  sendInput: (data: string) => void
  getKittyKeyboardFlags: () => number
}): TerminalImeRetainedHangulCommit {
  let retained: RetainedRange | null = null

  const retain = (textarea: HTMLTextAreaElement, committedText: string): boolean => {
    if (!HANGUL_TEXT.test(committedText) || textarea.selectionStart !== textarea.selectionEnd) {
      retained = null
      return false
    }
    const end = textarea.selectionEnd
    const start = end - committedText.length
    if (start < 0 || textarea.value.slice(start, end) !== committedText) {
      retained = null
      return false
    }
    // Consecutive commits extend one range so a rebuild spanning both still erases both.
    retained =
      retained && retained.textarea === textarea && retained.end === start && isIntact(retained)
        ? { textarea, start: retained.start, end, text: retained.text + committedText }
        : { textarea, start, end, text: committedText }
    return true
  }

  // Capture runs before xterm or the forwarder sends the replacement, so the PTY erases it first.
  const eraseReplacedRange = (event: Event): void => {
    const range = retained
    if (!range || event.target !== range.textarea) {
      return
    }
    if (event instanceof InputEvent && !FORWARDED_REPLACEMENT_INPUT_TYPES.has(event.inputType)) {
      return
    }
    const { selectionStart, selectionEnd } = range.textarea
    const replacesRetainedTail =
      isIntact(range) &&
      selectionStart < selectionEnd &&
      selectionStart >= range.start &&
      // Backspace erases from the PTY cursor, so the replaced text must be the last text sent.
      selectionEnd === range.end &&
      selectionEnd === range.textarea.value.length
    // A composition owns the field from here; its clause selections must not read as rebuilds.
    if (replacesRetainedTail || event.type === 'compositionstart' || !isIntact(range)) {
      retained = null
    }
    if (!replacesRetainedTail) {
      return
    }
    const replaced = Array.from(range.textarea.value.slice(selectionStart, selectionEnd)).length
    args.sendInput(encodeBackspace(args.getKittyKeyboardFlags()).repeat(replaced))
  }

  // Chords and named keys (Backspace, Enter, Ctrl+C) edit the PTY without the input method's text; observed here because the pane handles some before the forwarder sees them.
  const dropOnNonTextKeydown = (event: KeyboardEvent): void => {
    const range = retained
    const isPlainText = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey
    if (
      !range ||
      isPlainText ||
      event.keyCode === 229 ||
      event.isComposing ||
      MODIFIER_KEYS.has(event.key)
    ) {
      return
    }
    retained = null
    // Mirror the PTY edit in the field so the input method stops rebuilding text it no longer owns.
    if (isIntact(range) && range.end === range.textarea.value.length) {
      range.textarea.value = range.textarea.value.slice(0, range.start)
    }
  }

  // xterm empties the field on blur.
  const drop = (): void => {
    retained = null
  }

  args.terminalElement.addEventListener('compositionstart', eraseReplacedRange, true)
  args.terminalElement.addEventListener('beforeinput', eraseReplacedRange, true)
  args.terminalElement.addEventListener('keydown', dropOnNonTextKeydown, true)
  args.terminalElement.addEventListener('blur', drop, true)

  return {
    retain,
    dispose: () => {
      retained = null
      args.terminalElement.removeEventListener('keydown', dropOnNonTextKeydown, true)
      args.terminalElement.removeEventListener('blur', drop, true)
      args.terminalElement.removeEventListener('compositionstart', eraseReplacedRange, true)
      args.terminalElement.removeEventListener('beforeinput', eraseReplacedRange, true)
    }
  }
}
