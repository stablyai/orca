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
  /** Keys the input method never sees (Backspace, Enter, chords) invalidate its view of committed text. */
  observeUnclaimedKeydown: (event: { key: string; keyCode?: number; isComposing?: boolean }) => void
  dispose: () => void
}

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
    const textarea = event.target
    if (!range || textarea !== range.textarea) {
      return
    }
    const { selectionStart, selectionEnd } = range.textarea
    if (
      selectionStart >= selectionEnd ||
      selectionStart < range.start ||
      selectionEnd > range.end ||
      !isIntact(range)
    ) {
      return
    }
    retained = null
    const replaced = Array.from(range.textarea.value.slice(selectionStart, selectionEnd)).length
    args.sendInput(encodeBackspace(args.getKittyKeyboardFlags()).repeat(replaced))
  }

  const observeUnclaimedKeydown = (event: {
    key: string
    keyCode?: number
    isComposing?: boolean
  }): void => {
    const range = retained
    if (
      !range ||
      event.keyCode === 229 ||
      event.isComposing === true ||
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

  args.terminalElement.addEventListener('compositionstart', eraseReplacedRange, true)
  args.terminalElement.addEventListener('beforeinput', eraseReplacedRange, true)

  return {
    retain,
    observeUnclaimedKeydown,
    dispose: () => {
      retained = null
      args.terminalElement.removeEventListener('compositionstart', eraseReplacedRange, true)
      args.terminalElement.removeEventListener('beforeinput', eraseReplacedRange, true)
    }
  }
}
