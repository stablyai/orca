import type { Terminal } from '@xterm/xterm'
import type { WindowsInputRecordNewline } from './terminal-paste-model'
import {
  sanitizeBracketedPasteText,
  wrapTerminalBracketedPasteText
} from '../../../../shared/terminal-bracketed-paste-bytes'

type BracketedPasteTerminal = {
  modes: {
    bracketedPasteMode: boolean
  }
}

type PasteTerminal = BracketedPasteTerminal & {
  options: Pick<Terminal['options'], 'ignoreBracketedPasteMode'>
  input: (data: string) => void
  paste: (text: string) => void
}

type PasteTerminalTextOptions = {
  forceBracketedPaste?: boolean
  windowsInputRecordNewline?: WindowsInputRecordNewline
}

const interruptedBracketedPasteTerminals = new WeakSet<object>()
const bracketedPasteModeOutputTail = new WeakMap<object, string>()
const ESCAPE = '\u001b'
// One definition of the paste-byte recipe, shared with mobile. Re-exported so
// desktop call sites keep their existing imports.
export {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  sanitizeBracketedPasteText,
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '../../../../shared/terminal-bracketed-paste-bytes'
const BRACKETED_PASTE_MODE_SEQUENCE_RE = /^\[\?(?:\d+;)*2004(?:;\d+)*[hl]/
const BRACKETED_PASTE_MODE_TAIL_MAX = 128
const BRACKETED_PASTE_MODE_SEQUENCE_SCAN_MAX = BRACKETED_PASTE_MODE_TAIL_MAX
const LINE_BREAK_RE = /[\r\n]/

function hasBracketedPasteModeSequence(data: string): boolean {
  let escapeIndex = data.indexOf(ESCAPE)
  while (escapeIndex !== -1) {
    const sequenceStart = escapeIndex + 1
    if (
      data.charCodeAt(sequenceStart) === 0x5b &&
      BRACKETED_PASTE_MODE_SEQUENCE_RE.test(
        data.slice(sequenceStart, sequenceStart + BRACKETED_PASTE_MODE_SEQUENCE_SCAN_MAX)
      )
    ) {
      return true
    }
    escapeIndex = data.indexOf(ESCAPE, escapeIndex + 1)
  }
  return false
}

export function sanitizeTerminalPasteText(text: string): string {
  return sanitizeBracketedPasteText(text)
}

export function encodeWindowsInputRecordPasteText(
  text: string,
  newline: WindowsInputRecordNewline
): string {
  const newlineSequence = newline === 'csi-u' ? '\x1b[13;2u' : '\x1b\r'
  let encoded = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\r') {
      encoded += newlineSequence
      if (text[index + 1] === '\n') {
        index += 1
      }
    } else if (char === '\n') {
      encoded += newlineSequence
    } else {
      encoded += char === ESCAPE ? '\u241b' : char
    }
  }
  return encoded
}

function forceBracketedPaste(terminal: PasteTerminal, text: string): void {
  // Why: forced callers already built the exact paste protocol bytes. Send
  // them as PTY input so xterm's DOM/native paste machinery cannot defer them.
  terminal.input(wrapTerminalBracketedPasteText(text))
}

export function markTerminalBracketedPasteInterrupted(terminal: BracketedPasteTerminal): void {
  if (terminal.modes.bracketedPasteMode) {
    interruptedBracketedPasteTerminals.add(terminal)
  }
}

export function observeTerminalBracketedPasteModeOutput(
  terminal: BracketedPasteTerminal,
  data: string
): void {
  if (!interruptedBracketedPasteTerminals.has(terminal)) {
    bracketedPasteModeOutputTail.delete(terminal)
    return
  }
  const combined = (bracketedPasteModeOutputTail.get(terminal) ?? '') + data
  bracketedPasteModeOutputTail.set(terminal, combined.slice(-BRACKETED_PASTE_MODE_TAIL_MAX))
  if (hasBracketedPasteModeSequence(combined)) {
    interruptedBracketedPasteTerminals.delete(terminal)
    bracketedPasteModeOutputTail.delete(terminal)
  }
}

export function pasteTerminalText(
  terminal: PasteTerminal,
  text: string,
  options?: PasteTerminalTextOptions
): void {
  if (options?.windowsInputRecordNewline) {
    // Why: input-record TUIs see bracket markers as keys; modified Enter preserves
    // pasted newlines without turning the first one into submit.
    terminal.input(encodeWindowsInputRecordPasteText(text, options.windowsInputRecordNewline))
    return
  }
  if (options?.forceBracketedPaste) {
    // Why: generated image paths are paste payloads, even when they are a
    // single line, so they must bypass stale Ctrl+C plain-text suppression.
    forceBracketedPaste(terminal, text)
    return
  }
  if (!interruptedBracketedPasteTerminals.has(terminal)) {
    terminal.paste(text)
    return
  }
  if (!terminal.modes.bracketedPasteMode) {
    interruptedBracketedPasteTerminals.delete(terminal)
    bracketedPasteModeOutputTail.delete(terminal)
    terminal.paste(text)
    return
  }
  if (LINE_BREAK_RE.test(text)) {
    terminal.paste(text)
    return
  }

  const previousIgnoreBracketedPasteMode = terminal.options.ignoreBracketedPasteMode
  // Why: Ctrl+C can leave xterm's bracketed-paste bit stale after the foreground
  // process dies. Single-line paste does not need wrappers, so avoid leaking them.
  terminal.options.ignoreBracketedPasteMode = true
  try {
    terminal.paste(sanitizeTerminalPasteText(text))
  } finally {
    terminal.options.ignoreBracketedPasteMode = previousIgnoreBracketedPasteMode
  }
}
