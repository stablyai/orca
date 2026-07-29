import type { Terminal } from '@xterm/xterm'

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
}

const interruptedBracketedPasteTerminals = new WeakSet<object>()
const bracketedPasteModeOutputTail = new WeakMap<object, string>()
const ESCAPE = '\u001b'
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`
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

// Why: an embedded ESC (e.g. a pasted `\x1b[201~` from scrollback) would close
// the bracketed-paste frame early and run the tail as keystrokes. Replacing ESC
// with its printable substitute (\u241b, U+241B) neutralizes every framing escape.
export function sanitizeBracketedPasteText(text: string): string {
  let escapeIndex = text.indexOf(ESCAPE)
  if (escapeIndex === -1) {
    return text
  }

  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}\u241b`
    start = escapeIndex + ESCAPE.length
    escapeIndex = text.indexOf(ESCAPE, start)
  }
  return sanitized + text.slice(start)
}

export function sanitizeTerminalPasteText(text: string): string {
  return sanitizeBracketedPasteText(text)
}

export function normalizeTerminalPasteLineEndings(text: string): string {
  // Why: xterm's native paste path converts every clipboard newline to CR.
  // Direct frames must match it or ConPTY TUIs can treat raw LF as submit.
  return text.replace(/\r?\n/g, '\r')
}

export function wrapTerminalBracketedPasteText(text: string): string {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
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
