// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorktreeListVirtualizer } from './use-virtualizer'
import type { RenderRow } from '../listing/render-row'

/**
 * STA-6697, the half a corrected handoff comparison could not reach.
 *
 * `@tanstack/virtual-core`'s `observeOffset` registers a scroll listener and never reads the
 * element once, and `getScrollOffset()` seeds from `initialOffset` only while `scrollOffset` is
 * null. So a remount seeds the stale `scrollOffsetRef`, the element sits at 0, the list is too
 * short to scroll, and no scroll event ever arrives to correct it.
 *
 * That drift reaches the sticky decision twice, which is why correcting only the comparison moved
 * the pinned header exactly one project: the CANDIDATE comes from `rangeStartIndex`, and
 * `extractWorktreeVirtualRowIndexes` force-mounts only the active sticky header, the previous one
 * and the active host. A header two or more projects back is never mounted, has no geometry, and
 * cannot be selected at all. Hence the multi-header case below — a one-project drift would pass
 * against the un-fixed code and prove nothing.
 */

const ROW_HEIGHT = 36

function projectRows(count: number): RenderRow[] {
  return Array.from({ length: count }, (_, index) => [
    {
      type: 'header',
      key: `project-${index}`,
      label: `project-${index}`,
      count: 1,
      tone: 'text-foreground'
    } as RenderRow,
    { type: 'item', key: `wt-${index}`, sectionKey: `project-${index}` } as unknown as RenderRow
  ]).flat()
}

/** An element that cannot scroll: the browser clamps the write, so it never leaves 0. */
function createUnscrollableElement(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.append(element)
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => 0,
    set: () => undefined
  })
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 200 },
    clientHeight: { configurable: true, value: 200 }
  })
  return element
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('virtualizer offset against an element that cannot scroll', () => {
  // Enough projects that `overscan: 10` cannot mount the whole list: with a short list every row
  // is mounted anyway, the force-mount limit never bites, and the second assertion below would
  // pass against the un-fixed code. The seed puts the believed viewport many headers down.
  const rows = projectRows(40)
  const STALE_SEED = ROW_HEIGHT * 60

  function mountWithStaleSeed() {
    const element = createUnscrollableElement()
    const scrollRef = { current: element }
    const scrollOffsetRef = { current: STALE_SEED }
    const view = renderHook(() =>
      useWorktreeListVirtualizer({
        renderRows: rows,
        firstHeaderIndex: 0,
        scrollRef,
        scrollOffsetRef,
        suppressMeasurementAdjustmentUntilRef: { current: 0 }
      })
    )
    return { view, element }
  }

  it('reads the element at subscribe rather than trusting the stale seed', () => {
    const { view } = mountWithStaleSeed()

    // The seed is what the virtualizer believed; the element is the truth it never asked for.
    expect(view.result.current.virtualizer.scrollOffset).toBe(0)
  })

  // The multi-header consequence is NOT asserted here, deliberately. Under happy-dom the
  // virtualizer never measures a rect, so getVirtualItems() is empty and the rangeExtractor never
  // runs — rangeStartIndex stays 0 whether the offset is drifted or not. A sticky-header assertion
  // in this harness would pass identically with the fix reverted, i.e. prove nothing. Correcting
  // the offset at subscribe is the mechanism; that the right project then pins is a rendered
  // behaviour and belongs to the $electron validation on the real repro.
})
