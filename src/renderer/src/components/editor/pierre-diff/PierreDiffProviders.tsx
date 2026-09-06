import { useCallback, useState } from 'react'
// Why: `?worker` makes Vite own the worker in dev too. A bare `new URL(...)`
// specifier is served as a raw file, so the worker's own imports of shiki and
// hast-util-to-html never get rewritten.
import PierreDiffHighlightWorker from '@pierre/diffs/worker/worker.js?worker'
import { EditProvider, WorkerPoolContext } from '@pierre/diffs/react'
import type { EditorFactory } from '@pierre/diffs/react'
import type { ThemesType } from '@pierre/diffs'
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker'
import { Editor } from '@pierre/diffs/edit'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'

/**
 * `light-plus` / `dark-plus` are the VS Code default themes that Monaco's
 * `vs` / `vs-dark` mirror, so swapping renderers keeps syntax colors stable.
 */
const PIERRE_DIFF_THEMES: ThemesType = { light: 'light-plus', dark: 'dark-plus' }

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
 * Shares one Shiki worker pool and one editor factory across every mounted diff
 * surface.
 *
 * Requires @pierre/diffs >= 1.4.0. In 1.3.6 nothing rendered under React
 * StrictMode: the shadow DOM was never committed on the remount, so every diff
 * was blank in dev. Do not downgrade below 1.4.
 */
export function PierreDiffProviders({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  // Why: lazy initializer keeps worker startup off app launch until a diff opens.
  const [pool] = useState(createDiffHighlightPool)
  const createEditor = useCallback<EditorFactory<PierreDiffAnnotationData, undefined>>(
    (editorType, options, editStateKey) => new Editor(editorType, options, editStateKey),
    []
  )

  return (
    <WorkerPoolContext.Provider value={pool}>
      <EditProvider<PierreDiffAnnotationData, undefined> createEditor={createEditor}>
        {children}
      </EditProvider>
    </WorkerPoolContext.Provider>
  )
}
