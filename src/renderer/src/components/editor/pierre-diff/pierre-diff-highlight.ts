import { getFiletypeFromFileName, type FileDiffMetadata } from '@pierre/diffs'
import { createDiffHighlightPool } from './pierre-diff-highlight-pool'

/**
 * Pierre cancels a task (e.g. a theme change mid-flight) by rejecting its callbacks and dropping
 * the instance mapping in `clearInstanceRequests` -- it never calls `onHighlightError` on the
 * instance. Our renderer only learns of completion through those callbacks, so a cancelled task
 * would leave this promise pending forever and hang any caller awaiting it.
 */
const HIGHLIGHT_SETTLE_CEILING_MS = 10_000

export function preparePierreDiffHighlight(
  diff: FileDiffMetadata,
  signal: AbortSignal
): Promise<void> {
  const language = diff.lang ?? getFiletypeFromFileName(diff.name)
  const previousLanguage =
    diff.lang ?? (diff.prevName ? getFiletypeFromFileName(diff.prevName) : 'text')
  if (signal.aborted) {
    return Promise.reject(new DOMException('Canceled', 'AbortError'))
  }
  if (language === 'text' && previousLanguage === 'text') {
    return Promise.resolve()
  }
  const pool = createDiffHighlightPool()
  if (!pool.isWorkingPool()) {
    return Promise.reject(new Error('Diff highlighting worker is unavailable. Retry this file.'))
  }
  if (pool.getDiffResultCache(diff)) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const ceiling = setTimeout(() => finish(), HIGHLIGHT_SETTLE_CEILING_MS)
    const finish = (error?: unknown) => {
      clearTimeout(ceiling)
      signal.removeEventListener('abort', abort)
      pool.cleanUpTasks(renderer)
      if (error !== undefined) {
        reject(error)
      } else {
        resolve()
      }
    }
    const abort = () => finish(new DOMException('Canceled', 'AbortError'))
    const renderer = {
      __id: `orca-highlight:${diff.cacheKey}`,
      onHighlightSuccess: () => finish(),
      onHighlightError: (error: unknown) => finish(error)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      pool.highlightDiffAST(renderer, diff)
    } catch (error) {
      finish(error)
    }
  })
}
