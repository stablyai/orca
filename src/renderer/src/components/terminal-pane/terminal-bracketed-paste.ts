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
  yieldAfterChunk?: () => Promise<void>
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
const PASTE_CHUNK_SIZE = 512

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
  return text.includes(ESCAPE) ? text.replaceAll(ESCAPE, '\u241b') : text
}

export function wrapTerminalBracketedPasteText(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeTerminalPasteText(text)}${BRACKETED_PASTE_END}`
}

function defaultYieldAfterPasteChunk(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function getPasteChunkEnd(text: string, start: number): number {
  const end = Math.min(start + PASTE_CHUNK_SIZE, text.length)
  if (end >= text.length) {
    return end
  }
  const lastCodeUnit = text.charCodeAt(end - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end
}

async function writePasteChunks(
  text: string,
  write: (chunk: string) => void,
  yieldAfterChunk: () => Promise<void>
): Promise<void> {
  for (let start = 0; start < text.length; ) {
    const end = getPasteChunkEnd(text, start)
    write(text.slice(start, end))
    start = end
    if (start < text.length) {
      await yieldAfterChunk()
    }
  }
}

function writePasteText(
  text: string,
  write: (chunk: string) => void,
  yieldAfterChunk = defaultYieldAfterPasteChunk
): void | Promise<void> {
  if (text.length <= PASTE_CHUNK_SIZE) {
    write(text)
    return
  }
  return writePasteChunks(text, write, yieldAfterChunk)
}

function forceBracketedPaste(
  terminal: PasteTerminal,
  text: string,
  yieldAfterChunk?: () => Promise<void>
): void | Promise<void> {
  const sanitizedText = sanitizeTerminalPasteText(text)
  if (sanitizedText.length <= PASTE_CHUNK_SIZE) {
    // Why: forced callers already built the exact paste protocol bytes. Send
    // them as PTY input so xterm's DOM/native paste machinery cannot defer them.
    terminal.input(`${BRACKETED_PASTE_START}${sanitizedText}${BRACKETED_PASTE_END}`)
    return
  }

  return (async () => {
    terminal.input(BRACKETED_PASTE_START)
    try {
      const writeChunk = (chunk: string): void => terminal.input(chunk)
      await writePasteChunks(sanitizedText, writeChunk, yieldAfterChunk ?? defaultYieldAfterPasteChunk)
    } finally {
      terminal.input(BRACKETED_PASTE_END)
    }
  })()
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
): void | Promise<void> {
  if (options?.forceBracketedPaste) {
    return forceBracketedPaste(terminal, text, options.yieldAfterChunk)
  }
  if (!interruptedBracketedPasteTerminals.has(terminal)) {
    return writePasteText(text, (chunk) => terminal.paste(chunk), options?.yieldAfterChunk)
  }
  if (!terminal.modes.bracketedPasteMode) {
    interruptedBracketedPasteTerminals.delete(terminal)
    bracketedPasteModeOutputTail.delete(terminal)
    return writePasteText(text, (chunk) => terminal.paste(chunk), options?.yieldAfterChunk)
  }
  if (LINE_BREAK_RE.test(text)) {
    return writePasteText(text, (chunk) => terminal.paste(chunk), options?.yieldAfterChunk)
  }

  const previousIgnoreBracketedPasteMode = terminal.options.ignoreBracketedPasteMode
  // Why: Ctrl+C can leave xterm's bracketed-paste bit stale after the foreground
  // process dies. Single-line paste does not need wrappers, so avoid leaking them.
  terminal.options.ignoreBracketedPasteMode = true
  try {
    const pasteResult = writePasteText(
      sanitizeTerminalPasteText(text),
      (chunk) => terminal.paste(chunk),
      options?.yieldAfterChunk
    )
    if (pasteResult) {
      return pasteResult.finally(() => {
        terminal.options.ignoreBracketedPasteMode = previousIgnoreBracketedPasteMode
      })
    }
  } catch (error) {
    terminal.options.ignoreBracketedPasteMode = previousIgnoreBracketedPasteMode
    throw error
  }
  terminal.options.ignoreBracketedPasteMode = previousIgnoreBracketedPasteMode
}
