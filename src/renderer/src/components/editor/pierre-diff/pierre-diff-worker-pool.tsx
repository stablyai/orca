import { useState } from 'react'
// Why: `?worker` makes Vite own the worker in dev too. A bare `new URL(...)`
// specifier is served as a raw file, so the worker's own imports of shiki and
// hast-util-to-html never get rewritten.
import PierreDiffHighlightWorker from '@pierre/diffs/worker/worker.js?worker'
import { WorkerPoolContext } from '@pierre/diffs/react'
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker'
import { PIERRE_DIFF_THEMES } from './pierre-diff-theme'

// Why: Shiki grammars are heavy per worker; cap the pool well under Pierre's
// default of 8 so a diff tab can't starve the terminal and agent threads.
function resolvePoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4
  return Math.min(4, Math.max(1, cores - 2))
}

function createDiffHighlightPool(): WorkerPoolManager {
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new PierreDiffHighlightWorker(),
      poolSize: resolvePoolSize()
    },
    // Why: the pool owns `theme` for every component instance; per-file options are ignored.
    highlighterOptions: { theme: PIERRE_DIFF_THEMES }
  })
}

/**
 * Shares one Shiki worker pool across every mounted diff surface.
 *
 * Note: Pierre's own WorkerPoolContextProvider is bypassed. It terminates the
 * pool singleton from an unmount cleanup but only recreates it in `useState`,
 * so StrictMode's remount leaves every consumer holding a terminated pool.
 * We own the singleton and never tear it down.
 *
 * Why not Pierre's `WorkerPoolContextProvider`: it terminates the singleton from
 * an unmount cleanup, but recreates it only in `useState`. StrictMode's
 * mount/unmount/mount then leaves every consumer holding a terminated pool, so
 * nothing ever renders in dev. We own the singleton and never tear it down —
 * the pool is process-wide and cheap to keep warm for an app that reopens diffs
 * constantly.
 */
export function PierreDiffWorkerPoolProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  // Why: lazy initializer keeps worker startup off app launch until a diff opens.
  const [pool] = useState(createDiffHighlightPool)

  return <WorkerPoolContext.Provider value={pool}>{children}</WorkerPoolContext.Provider>
}
