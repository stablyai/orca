import { useMemo } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react'
import { PIERRE_DIFF_THEMES } from './pierre-diff-theme'

// Why: Shiki grammars are heavy per worker; cap the pool well under Pierre's
// default of 8 so a diff tab can't starve the terminal and agent threads.
function resolvePoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4
  return Math.min(4, Math.max(1, cores - 2))
}

function createDiffHighlightWorker(): Worker {
  // Why: electron.vite.config.ts pins `worker.format: 'es'`, which this URL form requires.
  return new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' })
}

/**
 * Shares one Shiki worker pool across every mounted diff surface. Pierre
 * reference-counts providers, so wrapping each lazy diff view keeps highlighting
 * off the main thread without paying worker startup on app launch.
 */
export function PierreDiffWorkerPoolProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const poolOptions = useMemo<WorkerPoolOptions>(
    () => ({ workerFactory: createDiffHighlightWorker, poolSize: resolvePoolSize() }),
    []
  )
  // Why: the pool owns `theme` for every component instance; per-file options are ignored.
  const highlighterOptions = useMemo<WorkerInitializationRenderOptions>(
    () => ({ theme: PIERRE_DIFF_THEMES }),
    []
  )

  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  )
}
