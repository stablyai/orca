// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Virtualizer, elementScroll } from '@tanstack/react-virtual'
import { getReconciledVirtualScrollOffset } from './scroll-offset-reconcile'
import { shouldAdjustWorktreeSidebarMeasuredRowScroll } from './use-scroll-suppression'

const VIEWPORT_HEIGHT = 285
const ESTIMATED_ROW = 116

// A list two cards tall inside a taller viewport: the browser clamps every
// scrollTo back to 0, so no scroll event ever reaches the virtualizer.
function createUnscrollableVirtualizer(): {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>
  element: HTMLDivElement
} {
  const element = document.createElement('div')
  Object.defineProperty(element, 'clientHeight', { value: VIEWPORT_HEIGHT })
  Object.defineProperty(element, 'scrollHeight', { value: ESTIMATED_ROW * 2 })
  element.scrollTo = () => {}
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 2,
    getScrollElement: () => element,
    estimateSize: () => ESTIMATED_ROW,
    scrollToFn: elementScroll,
    observeElementRect: (_instance, callback) => {
      callback({ width: 300, height: VIEWPORT_HEIGHT })
      return () => {}
    },
    observeElementOffset: () => () => {}
  })
  virtualizer._willUpdate()
  virtualizer.getVirtualItems()
  return { virtualizer, element }
}

const wireSidebarPredicate = (virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>): void => {
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustWorktreeSidebarMeasuredRowScroll({
      isScrolling: instance.isScrolling,
      now: 1_000,
      suppressUntil: 0,
      itemStart: item.start,
      itemEnd: item.end,
      scrollOffset: (instance.scrollOffset ?? 0) + instance.scrollAdjustments,
      isFirstMeasure: !instance.itemSizeCache.has(item.key),
      scrollDirection: instance.scrollDirection
    })
}

describe('virtualizer scroll offset under an unscrollable sidebar', () => {
  it('drifts when every measured resize is corrected (the previous predicate)', () => {
    const { virtualizer, element } = createUnscrollableVirtualizer()
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => true

    virtualizer.resizeItem(1, ESTIMATED_ROW + 24)

    expect(element.scrollTop).toBe(0)
    expect(virtualizer.scrollOffset).toBe(24)
    expect(virtualizer.getVirtualItems().at(0)?.start).toBe(0)
  })

  it('stays anchored to the element when only rows above the fold are corrected', () => {
    const { virtualizer, element } = createUnscrollableVirtualizer()
    wireSidebarPredicate(virtualizer)

    virtualizer.resizeItem(1, ESTIMATED_ROW + 24)
    virtualizer.resizeItem(0, ESTIMATED_ROW + 40)

    expect(element.scrollTop).toBe(0)
    expect(virtualizer.scrollOffset).toBe(0)
  })

  it('reconciles an already-drifted belief back to the element', () => {
    const { virtualizer, element } = createUnscrollableVirtualizer()
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => true
    virtualizer.resizeItem(1, ESTIMATED_ROW + 70)

    const reconciled = getReconciledVirtualScrollOffset({
      believedOffset: virtualizer.scrollOffset,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      isScrolling: virtualizer.isScrolling
    })

    expect(virtualizer.scrollOffset).toBe(70)
    expect(reconciled).toBe(0)
  })
})
