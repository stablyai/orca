// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { refreshMarkdownPreviewRowMeasurements } from './markdown-preview-row-measurements'

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
