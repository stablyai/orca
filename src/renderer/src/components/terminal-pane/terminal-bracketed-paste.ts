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
const BRACKETED_PASTE_START = `${ESCAPE}[200~`
const BRACKETED_PASTE_END = `${ESCAPE}[201~`
const BRACKETED_PASTE_MODE_SEQUENCE_RE = /^\[\?(?:\d+;)*2004(?:;\d+)*[hl]/
const BRACKETED_PASTE_MODE_TAIL_MAX = 128
const LINE_BREAK_RE = /[\r\n]/

function hasBracketedPasteModeSequence(data: string): boolean {
  const segments = data.split(ESCAPE)
  for (let index = 1; index < segments.length; index++) {
    if (BRACKETED_PASTE_MODE_SEQUENCE_RE.test(segments[index])) {
      return true
    }
  }
  return false
}

function sanitizeBracketedPasteText(text: string): string {
  return text.split(ESCAPE).join('\u241b')
}

function forceBracketedPaste(terminal: PasteTerminal, text: string): void {
  // Why: forced callers already built the exact paste protocol bytes. Send
  // them as PTY input so xterm's DOM/native paste machinery cannot defer them.
  terminal.input(
    `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(text)}${BRACKETED_PASTE_END}`
  )
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
    terminal.paste(sanitizeBracketedPasteText(text))
  } finally {
    terminal.options.ignoreBracketedPasteMode = previousIgnoreBracketedPasteMode
  }
}
