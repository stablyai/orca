import { useCodeEditorThemeStore } from '@/store/appearance/code-editor-theme'
import { resolvePierreDiffTheme } from './pierre-diff-theme'
import { useEffect, useState, type RefObject } from 'react'
import { Virtualizer } from '@pierre/diffs'
import { EditProvider, WorkerPoolContext, VirtualizerContext } from '@pierre/diffs/react'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'
import { createDiffHighlightPool } from './pierre-diff-highlight-pool'
import { createPierreEditor } from './pierre-diff-edit-state'
import { PierreDiffNarrowLayoutContext } from './pierre-diff-layout'

/**
 * Shares one Shiki worker pool and one editor factory across every mounted diff
 * surface.
 *
 * Requires @pierre/diffs >= 1.4.0. In 1.3.6 nothing rendered under React
 * StrictMode: the shadow DOM was never committed on the remount, so every diff
 * was blank in dev. Do not downgrade below 1.4.
 */
export function PierreDiffProviders({
  children,
  scrollContainerRef
}: {
  children: React.ReactNode
  scrollContainerRef: RefObject<HTMLElement | null>
}): React.JSX.Element {
  // Why: lazy initializer keeps worker startup off app launch until a diff opens.
  const [pool] = useState(createDiffHighlightPool)
  const editorTheme = useCodeEditorThemeStore((s) => s.monaco)
  useEffect(() => {
    void pool
      .setRenderOptions({ theme: resolvePierreDiffTheme(editorTheme) })
      .catch((error: unknown) => {
        console.error('Diff theme update failed:', error)
      })
  }, [pool, editorTheme])
  const [virtualizer] = useState(() => new Virtualizer())
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    virtualizer.setup(container, container.lastElementChild ?? undefined)
    const resize = new ResizeObserver(() => setNarrow(container.clientWidth <= 900))
    resize.observe(container)
    return () => {
      resize.disconnect()
      virtualizer.cleanUp()
    }
  }, [scrollContainerRef, virtualizer])

  return (
    <WorkerPoolContext.Provider value={pool}>
      <VirtualizerContext.Provider value={virtualizer}>
        <PierreDiffNarrowLayoutContext.Provider value={narrow}>
          <EditProvider<PierreDiffAnnotationData, undefined> createEditor={createPierreEditor}>
            {children}
          </EditProvider>
        </PierreDiffNarrowLayoutContext.Provider>
      </VirtualizerContext.Provider>
    </WorkerPoolContext.Provider>
  )
}
