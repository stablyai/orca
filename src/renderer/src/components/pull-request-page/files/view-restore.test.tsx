// @vitest-environment happy-dom
import { act, render } from '@testing-library/react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { getCombinedDiffExtent } from '@/components/editor/combined-diff-extent-dom'
import { useCombinedDiffViewport } from '@/components/editor/use-combined-diff-extent'
import { prFilesDiffScrollTopCache, prFilesDiffViewStateCache } from '../cache/files-diff-view'
import { usePRFilesDiffViewPersistence } from './view-restore'

afterEach(() => {
  prFilesDiffScrollTopCache.clear()
  prFilesDiffViewStateCache.clear()
})

it('restores a late PR viewport once and exports its outgoing context before detach', () => {
  prFilesDiffScrollTopCache.set('pr-a', 2500)
  let attach = () => {}
  let detach = () => {}
  const viewport: { current: HTMLDivElement | null } = { current: null }
  function Viewer({ signature }: { signature: string }) {
    const [visible, setVisible] = useState(false)
    const { scrollContainerRef, viewportNode, setViewport, beforeDetachRef, releaseViewport } =
      useCombinedDiffViewport()
    const pendingRestoreScrollTopRef = useRef<number | null>(null)
    const loadedIndicesRef = useRef(new Set<number>())
    attach = () => setVisible(true)
    detach = () => setVisible(false)
    const ref = useCallback(
      (element: HTMLDivElement | null) => {
        const outgoing = scrollContainerRef.current
        setViewport(element)
        if (!element && outgoing) {
          outgoing.scrollTop = 0
        }
        viewport.current = element
        if (element) {
          Object.defineProperty(element, 'clientHeight', { value: 700 })
        }
      },
      [scrollContainerRef, setViewport]
    )
    usePRFilesDiffViewPersistence({
      sections: [],
      entriesLength: 1,
      viewStateKey: 'pr-a',
      entrySignature: signature,
      sectionHeights: {},
      sideBySide: true,
      fileTreeCollapsed: false,
      activeTreeSectionKey: null,
      loadedIndicesRef,
      viewportNode,
      beforeDetachRef,
      releaseViewport,
      pendingRestoreScrollTopRef
    })
    useLayoutEffect(() => {
      if (viewportNode) {
        getCombinedDiffExtent(viewportNode).publish([
          { key: 'file-a', index: 0, start: 0, end: 10000, size: 10000, lane: 0 }
        ])
      }
    }, [viewportNode, signature])
    return visible ? (
      <div ref={ref}>
        <div data-combined-diff-extent="" />
      </div>
    ) : null
  }
  const view = render(<Viewer signature="one" />)
  expect(viewport.current).toBeNull()
  act(() => attach())
  const outgoing = viewport.current
  if (!outgoing) {
    throw new Error('PR viewport did not attach')
  }
  expect(outgoing.scrollTop).toBe(2500)
  const owner = getCombinedDiffExtent(outgoing)
  const imports = vi.spyOn(owner, 'importView')
  act(() => owner.navigate(2700))
  view.rerender(<Viewer signature="two" />)
  expect(imports).not.toHaveBeenCalled()
  expect(outgoing.scrollTop).toBe(2700)
  act(() => detach())
  expect(outgoing.scrollTop).toBe(0)
  expect(prFilesDiffScrollTopCache.get('pr-a')).toBe(2700)
  act(() => attach())
  const incoming = viewport.current
  if (!incoming) {
    throw new Error('PR viewport did not remount')
  }
  expect(incoming).not.toBe(outgoing)
  expect(incoming.scrollTop).toBe(2700)
  view.unmount()
})
