import PierreDiffParseWorker from './pierre-diff-parse.worker?worker'
import { setLineDiffProvider } from '@pierre/diffs'
import {
  cachePierreDiff,
  getCachedPierreDiff,
  getPierreDiffCacheIdentity
} from './pierre-diff-cache-identity'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { createPierreDiffParseScheduler } from './pierre-diff-parse-scheduler'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'
import { computePierreLineChanges, type PierreLineChanges } from './pierre-diff-line-changes'
import { formatPierreLinePatch } from './pierre-diff-line-patch'

const scheduler = createPierreDiffParseScheduler(() => new PierreDiffParseWorker())
let nextRequestId = 0
// Bounds a synchronous edit-session region diff on the UI thread; larger regions go to the worker.
const MAX_SYNC_REGION_LINES = 500

setLineDiffProvider({
  syncLineLimit: MAX_SYNC_REGION_LINES,
  computeSync: (oldLines, newLines, options) =>
    computePierreLineChanges(oldLines, newLines, Boolean(options?.ignoreWhitespace)),
  computeAsync: (oldLines, newLines, options) =>
    scheduler.request<PierreLineChanges>(
      {
        id: ++nextRequestId,
        lines: { oldLines, newLines, ignoreWhitespace: Boolean(options?.ignoreWhitespace) }
      },
      new AbortController().signal
    ),
  formatPatch: formatPierreLinePatch
})

export async function requestPierreDiffMetadata(input: PierreDiffInput, signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException('Canceled', 'AbortError')
  }
  const identity = getPierreDiffCacheIdentity(
    JSON.stringify([
      input.cacheKey,
      input.path,
      input.oldPath,
      input.status,
      input.lang,
      input.parseDiffOptions
    ]),
    input.originalContent,
    input.modifiedContent
  )
  const cached = getCachedPierreDiff(identity)
  if (cached) {
    return cached
  }
  const diff = await scheduler.request({ id: ++nextRequestId, identity, input }, signal)
  if (diff.cacheKey === identity) {
    cachePierreDiff(identity, diff)
  }
  return diff
}

export async function requestPierreFileDiff(
  input: PierreDiffInput,
  signal: AbortSignal,
  blockOnHighlight = false,
  onHighlightError?: (error: unknown) => void
) {
  const diff = await requestPierreDiffMetadata(input, signal)
  // Why conditional: entering edit mode otherwise highlights the whole file synchronously, so an
  // editable surface still waits. For a read-only diff, awaiting it put a whole-file AST
  // structured-clone on the critical path -- Pierre paints a viewport-windowed plain AST first and
  // upgrades when this resolves, so blocking here only delayed the first paint.
  const highlight = preparePierreDiffHighlight(diff, signal)
  if (blockOnHighlight) {
    try {
      await highlight
    } catch (error) {
      if (signal.aborted || !diff.lang?.startsWith('orca-plugin-syntax-')) {
        throw error
      }
      // A stalled initial highlight must not prevent entering edit mode.
      return { ...diff, lang: 'text' }
    }
  } else {
    // Why report rather than swallow: a dead worker pool used to reject this call, which gave the
    // user the retry affordance. Detaching it must not cost that -- only an abort is silent.
    highlight.catch((error: unknown) => {
      if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        onHighlightError?.(error)
      }
    })
  }
  return diff
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => scheduler.dispose())
}
