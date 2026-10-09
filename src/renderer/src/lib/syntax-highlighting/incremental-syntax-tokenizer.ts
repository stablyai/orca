import type { SyntaxHighlighter, SyntaxHighlightState, SyntaxToken } from './syntax-highlighter'

export type SyntaxLine = {
  /** Offset of the line in the document; unique, so it keys the line. */
  start: number
  tokens: readonly SyntaxToken[]
  /** The separator the source has after this line, CRLF included. */
  ending: string
}

export type SyntaxProgress = {
  lines: SyntaxLine[]
  /** `code.slice(highlightedLength)` has not been tokenized yet. */
  highlightedLength: number
  /** A line was skipped, so the lines after it stay plain. */
  degraded: boolean
}

// A batch cannot be interrupted, so it stays near a millisecond of dense code.
const BATCH_LENGTH = 250
const BATCH_LINES = 10

/**
 * The text of a run of lines without its final separator, copied out of the
 * document: a substring keeps its parent alive, so tokens cut straight from a
 * streaming block would pin every copy of it that streamed past.
 */
function detachedLines(text: string): string {
  return ` ${text.replace(/\r?\n$/, '')}`.slice(1)
}

/**
 * Tokenizes a document a few lines at a time, resuming after the last completed
 * line, and stops once `budgetMs` is spent. Completed lines keep their identity.
 */
export function createIncrementalSyntaxTokenizer(
  highlight: SyntaxHighlighter
): (code: string, budgetMs: number) => SyntaxProgress {
  let completed = ''
  let state: SyntaxHighlightState | undefined
  let lines: SyntaxLine[] = []
  let degraded = false

  return (code, budgetMs) => {
    if (!code.startsWith(completed)) {
      completed = ''
      state = undefined
      lines = []
      degraded = false
    }
    const deadline = performance.now() + budgetMs
    // Why: markdown ends a fence still being written with a newline, so the last line can grow.
    const lastBreak = code.lastIndexOf('\n', code.length - 2) + 1
    while (completed.length < lastBreak) {
      if (performance.now() >= deadline) {
        return { lines, highlightedLength: completed.length, degraded }
      }
      const from = completed.length
      let end = from
      for (let count = 0; count < BATCH_LINES && end < lastBreak; count += 1) {
        const next = code.indexOf('\n', end) + 1
        if (count > 0 && next - from > BATCH_LENGTH) {
          break
        }
        end = next
      }
      const tokenized = highlight(detachedLines(code.slice(from, end)), state)
      state = tokenized.state
      degraded ||= tokenized.outcome !== 'ok'
      let start = from
      const batch = tokenized.lines.map((tokens) => {
        const lineEnd = tokens.reduce((offset, token) => offset + token.content.length, start)
        const ending = code.startsWith('\r\n', lineEnd) ? '\r\n' : '\n'
        const line = { start, tokens, ending }
        start = lineEnd + ending.length
        return line
      })
      lines = [...lines, ...batch]
      completed = code.slice(0, end)
    }
    const last = code.slice(completed.length)
    if (!last) {
      return { lines, highlightedLength: code.length, degraded }
    }
    if (performance.now() >= deadline) {
      return { lines, highlightedLength: completed.length, degraded }
    }
    const text = detachedLines(last)
    const partial = highlight(text, state)
    return {
      lines: [
        ...lines,
        { start: completed.length, tokens: partial.lines[0] ?? [], ending: last.slice(text.length) }
      ],
      highlightedLength: code.length,
      degraded: degraded || partial.outcome !== 'ok'
    }
  }
}
