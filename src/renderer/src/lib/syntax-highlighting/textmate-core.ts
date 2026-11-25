import type { HighlighterCore, RegexEngine, ThemeInput } from 'shiki/core'
import type * as ShikiTextmate from 'shiki/textmate'
import { loadOniguruma, type Oniguruma } from './oniguruma'

// Why: one regex scan over a line cannot be interrupted, and its cost grows with the square of the line's length.
const MAX_TOKENIZED_LINE_LENGTH = 1000
// Why: TextMate checks this between regex scans, so a pathological line ends instead of freezing the window.
const LINE_TIME_LIMIT_MS = 50
const LINE_ATTEMPTS = 3
// Initial grammar regex compilation is uninterruptible; slow first lines can exhaust LINE_ATTEMPTS before a reusable compiled pass.
export const COLD_GRAMMAR_LINE_ATTEMPTS = 10

export type TextMateCore = { core: HighlighterCore; textmate: typeof ShikiTextmate }

function onigurumaEngine(oniguruma: Oniguruma): RegexEngine {
  return {
    createScanner: (patterns) => {
      const scanner = oniguruma.createOnigScanner(
        patterns.map((pattern) => (typeof pattern === 'string' ? pattern : pattern.source))
      )
      return {
        // Why: Shiki's TextMate always passes no find options, so none are forwarded.
        findNextMatchSync: (text, startPosition) =>
          scanner.findNextMatchSync(
            typeof text === 'string' || text instanceof oniguruma.OnigString ? text : text.content,
            startPosition
          ),
        dispose: () => scanner.dispose()
      }
    },
    createString: (text) => oniguruma.createOnigString(text)
  }
}

/** Share Oniguruma WASM across per-owner TextMate registries; each registry holds only one grammar per scope. */
export async function createTextMateCore(themes: ThemeInput[]): Promise<TextMateCore> {
  const [{ createHighlighterCore }, textmate, oniguruma] = await Promise.all([
    import('shiki/core'),
    import('shiki/textmate'),
    loadOniguruma()
  ])
  const core = await createHighlighterCore({
    themes,
    langs: [],
    engine: onigurumaEngine(oniguruma)
  })
  return { core, textmate }
}

/**
 * Runs `tokenize` on `line` under the per-line limits. Null when the line is
 * too long or keeps running out of time; its end state is then unknown.
 */
export function tokenizeLineWithinLimits<Result extends { stoppedEarly: boolean }>(
  line: string,
  tokenize: (line: string, timeLimitMs: number) => Result,
  attempts = LINE_ATTEMPTS
): Result | null {
  if (line.length > MAX_TOKENIZED_LINE_LENGTH) {
    return null
  }
  let result = tokenize(line, LINE_TIME_LIMIT_MS)
  // Why: the first lines through a grammar also compile its regexes, which happens only once.
  for (let attempt = 1; result.stoppedEarly && attempt < attempts; attempt += 1) {
    result = tokenize(line, LINE_TIME_LIMIT_MS)
  }
  return result.stoppedEarly ? null : result
}
