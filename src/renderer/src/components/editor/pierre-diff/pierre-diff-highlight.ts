import { getFiletypeFromFileName, type FileDiffMetadata } from '@pierre/diffs'
import { createDiffHighlightPool } from './pierre-diff-highlight-pool'

/**
 * Pierre cancels a task (e.g. a theme change mid-flight) by rejecting its callbacks and dropping
 * the instance mapping in `clearInstanceRequests` -- it never calls `onHighlightError` on the
 * instance. Our renderer only learns of completion through those callbacks, so a cancelled task
 * would leave this promise pending forever and hang any caller awaiting it.
 *
 * Pierre's worker init timeout is 10s and also skips instance callbacks on failure, so this must
 * outlive init plus a whole-file highlight. Resolving as success used to unprime editable mounts
 * and cleanUpTasks would cancel the still-running worker if we were the only instance.
 */
const HIGHLIGHT_SETTLE_CEILING_MS = 30_000

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
    let settled = false
    const ceiling = setTimeout(() => {
      if (pool.getDiffResultCache(diff)) {
        finish()
        return
      }
      // Why not cleanUpTasks: the worker may still be running (init + highlight can exceed the
      // old 10s cap). Detach-and-cancel made the next editable paint highlight on the main thread.
      finish(new Error('Diff highlighting timed out. Retry this file.'), false)
    }, HIGHLIGHT_SETTLE_CEILING_MS)
    const finish = (error?: unknown, cancelTask = true) => {
      clearTimeout(ceiling)
      if (cancelTask) {
        // Timeout leaves the listener so unmount can still detach if the worker never notifies.
        signal.removeEventListener('abort', abort)
        pool.cleanUpTasks(renderer)
      }
      if (settled) {
        return
      }
      settled = true
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
