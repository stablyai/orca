// Why: `?worker` makes Vite own the worker in dev too. A bare `new URL(...)`
// specifier is served as a raw file, so the worker's own imports of shiki and
// hast-util-to-html never get rewritten.
import PierreDiffHighlightWorker from '@pierre/diffs/worker/worker.js?worker'
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker'
import { PIERRE_DIFF_THEMES } from './pierre-diff-options'

// Why: Shiki grammars are heavy per worker; cap the pool well under Pierre's
// default of 8 so a diff tab can't starve the terminal and agent threads.
function resolvePoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4
  return Math.min(4, Math.max(1, cores - 2))
}

/**
 * Pierre's own WorkerPoolContextProvider is bypassed: it terminates the pool
 * singleton from an unmount cleanup but only recreates it in `useState`, so
 * StrictMode's remount leaves every consumer holding a terminated pool. We own
 * the singleton and never tear it down — it is process-wide and cheap to keep
 * warm for an app that reopens diffs constantly.
 */
export function createDiffHighlightPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new PierreDiffHighlightWorker(),
      poolSize: resolvePoolSize(),
      // Why: each entry is a whole-file per-line AST and a mounted row pins its own on top of
      // this. Pierre's default of 100 retained ~63MB more than the Monaco path it replaced, but
      // the bound must stay clear of the mounted-section count (overscan 5/side puts 15-25 rows
      // in the DOM) or scrolling back evicts a row's AST and flashes it unhighlighted. Measured
      // on a 150-file diff: 100 (default) 150MB, 48 133MB, 32 104MB, 16 104MB -- 32 is the
      // cheapest value that still clears the mounted count.
      totalASTLRUCacheSize: 32
    },
    // Why: the pool owns `theme` for every component instance; per-file options are ignored.
    highlighterOptions: { theme: PIERRE_DIFF_THEMES, useTokenTransformer: true }
  })
}
