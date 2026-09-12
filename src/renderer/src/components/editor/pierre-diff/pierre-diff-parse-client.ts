import PierreDiffParseWorker from './pierre-diff-parse.worker?worker'
import { getPierreDiffCacheIdentity } from './pierre-diff-cache-identity'
import type { PierreDiffInput } from './pierre-diff-metadata'
import { createPierreDiffParseScheduler } from './pierre-diff-parse-scheduler'
import { preparePierreDiffHighlight } from './pierre-diff-highlight'

const scheduler = createPierreDiffParseScheduler(() => new PierreDiffParseWorker())
let nextRequestId = 0

export async function requestPierreFileDiff(
  input: PierreDiffInput,
  signal: AbortSignal,
  blockOnHighlight = false,
  onHighlightError?: (error: unknown) => void
) {
  const identity = getPierreDiffCacheIdentity(
    JSON.stringify([
      input.cacheKey,
      input.path,
      input.oldPath,
      input.status,
      input.parseDiffOptions
    ]),
    input.originalContent,
    input.modifiedContent
  )
  const diff = await scheduler.request({ id: ++nextRequestId, identity, input }, signal)
  // Why conditional: entering edit mode otherwise highlights the whole file synchronously, so an
  // editable surface still waits. For a read-only diff, awaiting it put a whole-file AST
  // structured-clone on the critical path -- Pierre paints a viewport-windowed plain AST first and
  // upgrades when this resolves, so blocking here only delayed the first paint.
  const highlight = preparePierreDiffHighlight(diff, signal)
  if (blockOnHighlight) {
    await highlight
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
