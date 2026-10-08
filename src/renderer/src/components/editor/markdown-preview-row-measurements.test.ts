// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import {
  refreshMarkdownPreviewRowMeasurements,
  pruneMarkdownPreviewRowMeasurements,
  shouldAdjustMarkdownPreviewRowScroll
} from './markdown-preview-row-measurements'

function createVirtualizer() {
  return new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 3,
    getScrollElement: () => null,
    estimateSize: () => 56,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
    initialRect: { width: 100, height: 300 }
  })
}

function loadedRow(body: HTMLDivElement, index: number, height: number) {
  const row = document.createElement('div')
  row.dataset.index = String(index)
  row.dataset.previewBlockLoaded = 'true'
  const measure = vi
    .spyOn(row, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 100, height))
  body.append(row)
  return measure
}

describe('large preview loaded-row measurements', () => {
  it('drops obsolete source keys after a revision while preserving remaining heights', () => {
    const virtualizer = createVirtualizer()
    virtualizer.setOptions({ ...virtualizer.options, getItemKey: (index) => String(index + 1) })
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(0, 94)
    virtualizer.resizeItem(1, 75)
    virtualizer.setOptions({
      ...virtualizer.options,
      count: 2,
      getItemKey: (index) => String(index * 2 + 1)
    })
    pruneMarkdownPreviewRowMeasurements(virtualizer)
    expect([...virtualizer.itemSizeCache.keys()]).toEqual(['1'])
    expect(virtualizer.getVirtualItems().map((row) => row.size)).toEqual([94, 56])
  })

  it('preserves unchanged actual heights after resetting stale measurement slots', () => {
    const virtualizer = createVirtualizer()
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(0, 94)
    expect(virtualizer.getVirtualItems().map((row) => row.size)).toEqual([94, 56, 56])
    const body = document.createElement('div')
    loadedRow(body, 0, 94)
    refreshMarkdownPreviewRowMeasurements(virtualizer, body, true)
    expect(virtualizer.getVirtualItems().map((row) => row.size)).toEqual([94, 56, 56])
    expect(virtualizer.itemSizeCache.get(0)).toBe(94)
  })

  it('refreshes new content during scrolling while retaining other measured rows', () => {
    const virtualizer = createVirtualizer()
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(0, 94)
    virtualizer.resizeItem(1, 75)
    virtualizer.getVirtualItems()
    virtualizer.isScrolling = true
    const body = document.createElement('div')
    loadedRow(body, 0, 133)
    const placeholder = document.createElement('div')
    placeholder.dataset.index = '1'
    body.append(placeholder)
    refreshMarkdownPreviewRowMeasurements(virtualizer, body, false)
    expect(virtualizer.getVirtualItems().map((row) => row.size)).toEqual([133, 75, 56])
  })
})

describe('large preview measurement scroll corrections', () => {
  it('corrects backward growth and shrink above the reader, leaving visible rows alone', () => {
    const scroll = vi.fn()
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 10,
      getScrollElement: () => null,
      estimateSize: () => 100,
      scrollToFn: scroll,
      observeElementRect: () => () => {},
      observeElementOffset: () => () => {},
      initialOffset: 550,
      initialRect: { width: 100, height: 300 }
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustMarkdownPreviewRowScroll
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(2, 140)
    virtualizer.getVirtualItems()
    virtualizer.scrollDirection = 'backward'
    scroll.mockClear()
    virtualizer.resizeItem(2, 180)
    expect(scroll).toHaveBeenCalledExactlyOnceWith(
      590,
      { adjustments: 40, behavior: undefined },
      virtualizer
    )
    virtualizer.getVirtualItems()
    scroll.mockClear()
    virtualizer.resizeItem(2, 140)
    expect(scroll).toHaveBeenCalledExactlyOnceWith(
      630,
      { adjustments: -40, behavior: undefined },
      virtualizer
    )
    virtualizer.getVirtualItems()
    virtualizer.resizeItem(5, 110)
    virtualizer.getVirtualItems()
    scroll.mockClear()
    virtualizer.resizeItem(5, 120)
    virtualizer.resizeItem(8, 120)
    expect(scroll).not.toHaveBeenCalled()
    virtualizer.getVirtualItems()
    const row = virtualizer.getVirtualItems().find((item) => item.index === 5)!
    virtualizer.scrollOffset = row.end
    virtualizer.resizeItem(5, 130)
    expect(scroll).toHaveBeenCalledExactlyOnceWith(
      row.end,
      { adjustments: 10, behavior: undefined },
      virtualizer
    )
  })
})
