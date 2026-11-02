import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  createIncrementalSyntaxTokenizer,
  type SyntaxProgress
} from '@/lib/syntax-highlighting/incremental-syntax-tokenizer'
import { scheduleSyntaxHighlighting } from '@/lib/syntax-highlighting/syntax-highlight-scheduler'
import {
  loadedSyntaxHighlighter,
  loadSyntaxLanguage
} from '@/lib/syntax-highlighting/syntax-highlighter'
import { BoundedMap } from '../../../shared/bounded-map'

// Each token is a DOM node, so only the start of a very long block is colored.
const MAX_HIGHLIGHTED_CODE_LENGTH = 50_000
// Tokenizing runs on the renderer thread, so it is spent in slices shorter than a frame.
const RENDER_BUDGET_MS = 4
const MAX_FINISHED_BYTES = 8 * 1024 * 1024
const MAX_FINISHED_ENTRIES = 256
// Rough retained size of one token object beyond its text.
const TOKEN_OVERHEAD_BYTES = 120
const LINE_OVERHEAD_BYTES = 80

let renderDeadline: number | null = null

/** One budget for every block that renders in the same task, however many mount at once. */
function remainingRenderBudgetMs(): number {
  if (renderDeadline === null) {
    renderDeadline = performance.now() + RENDER_BUDGET_MS
    setTimeout(() => {
      renderDeadline = null
    }, 0)
  }
  return Math.max(0, renderDeadline - performance.now())
}

/** UTF-16 text in the key and the tokens' copies of it, plus the objects holding them. */
function finishedBytes(progress: SyntaxProgress, key: string): number {
  let bytes = key.length * 2
  for (const line of progress.lines) {
    bytes += LINE_OVERHEAD_BYTES
    for (const token of line.tokens) {
      bytes += TOKEN_OVERHEAD_BYTES + token.content.length * 2
    }
  }
  return bytes
}

// Finished blocks, so a row scrolled back into view paints in color without tokenizing again.
const finished = new BoundedMap<string, SyntaxProgress>({
  maxEntries: MAX_FINISHED_ENTRIES,
  maxBytes: MAX_FINISHED_BYTES,
  sizeOf: finishedBytes
})

function finishedKey(language: string, source: string): string {
  return `${language}\n${source}`
}

/**
 * Tokens for as much of `code` as has been colored so far, or null while there
 * is nothing to color it with. The rest, `code.slice(highlightedLength)`, is
 * still plain and arrives over later renders.
 */
export function useHighlightedSyntax(code: string, language: string): SyntaxProgress | null {
  const source =
    code.length > MAX_HIGHLIGHTED_CODE_LENGTH ? code.slice(0, MAX_HIGHLIGHTED_CODE_LENGTH) : code
  const highlighter = loadedSyntaxHighlighter(language)
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  // Why: `source` is a dependency so a block still streaming asks again after a failed load.
  useEffect(() => {
    if (highlighter) {
      return
    }
    let cancelled = false
    void loadSyntaxLanguage(language).then((status) => {
      if (!cancelled && status === 'ready') {
        rerender()
      }
    })
    return () => {
      cancelled = true
    }
  }, [language, highlighter, source])

  const tokenize = useMemo(
    () => (highlighter ? createIncrementalSyntaxTokenizer(highlighter) : null),
    [highlighter]
  )
  // Short blocks finish here and paint in color at once; longer ones continue below.
  const started = useMemo(
    () =>
      finished.get(finishedKey(language, source)) ??
      (tokenize ? tokenize(source, remainingRenderBudgetMs()) : null),
    [language, source, tokenize]
  )
  const [continued, setContinued] = useState<{
    after: SyntaxProgress
    progress: SyntaxProgress
  } | null>(null)
  const progress = continued?.after === started ? continued.progress : started

  useEffect(() => {
    if (!tokenize || !started || started.highlightedLength >= source.length) {
      return
    }
    return scheduleSyntaxHighlighting((budgetMs) => {
      const next = tokenize(source, budgetMs)
      setContinued({ after: started, progress: next })
      return next.highlightedLength >= source.length
    })
  }, [source, started, tokenize])

  const latest = useRef({ language, source, progress })
  useEffect(() => {
    latest.current = { language, source, progress }
  })
  // Why: remembered on unmount, not on every streamed chunk, which would fill the cache with prefixes.
  useEffect(
    () => () => {
      const last = latest.current
      // A degraded block may only have lost its grammar mid-stream, so it is colored afresh next time.
      if (
        last.progress &&
        !last.progress.degraded &&
        last.progress.highlightedLength >= last.source.length
      ) {
        finished.set(finishedKey(last.language, last.source), last.progress)
      }
    },
    []
  )

  return progress
}
