import { describe, expect, it } from 'vitest'
import type { PdfViewPosition } from '@/lib/scroll-cache'
import {
  deletePaneScopedCacheEntries,
  sweepClosedPdfViewPositions
} from './closed-editor-tab-cache-sweep'

const position = (pageNumber: number): PdfViewPosition => ({ pageNumber, top: 0, left: 0 })

describe('deletePaneScopedCacheEntries', () => {
  it('does not delete an owner whose id merely extends a closed owner id', () => {
    const cache = new Map([
      ['tab-1::pane-1', 1],
      ['tab-10::pane-1', 2],
      ['tab-1x::pane-1', 3]
    ])
    deletePaneScopedCacheEntries(cache, ['tab-1'])
    expect([...cache.keys()]).toEqual(['tab-10::pane-1', 'tab-1x::pane-1'])
  })

  it('matches an owner that ends at the second `::` of a `:::` run', () => {
    // Locks the `boundary + 1` advance in hasPaneScopeOwner: `a:` ends at index 2, which only the
    // second `::` of the run exposes. A `+ 2` advance would skip it and leak the entry.
    const cache = new Map([
      ['a:::b', 1],
      ['a::b', 2],
      ['ab:::c', 3]
    ])
    deletePaneScopedCacheEntries(cache, ['a:'])
    expect([...cache.keys()]).toEqual(['a::b', 'ab:::c'])
  })

  it('sweeps every owner in the batch in one pass', () => {
    const cache = new Map([
      ['tab-1::pane-1', 1],
      ['tab-2::pane-1', 2],
      ['tab-3::pane-1', 3]
    ])
    deletePaneScopedCacheEntries(cache, ['tab-1', 'tab-3'])
    expect([...cache.keys()]).toEqual(['tab-2::pane-1'])
  })

  it('is a no-op for an empty owner batch', () => {
    const cache = new Map([['tab-1::pane-1', 1]])
    deletePaneScopedCacheEntries(cache, [])
    expect(cache.size).toBe(1)
  })
})

describe('sweepClosedPdfViewPositions', () => {
  it('deletes the unscoped :pdf entry', () => {
    const cache = new Map([['/a.pdf:pdf', position(4)]])
    sweepClosedPdfViewPositions(cache, ['/a.pdf'])
    expect(cache.size).toBe(0)
  })

  it('deletes pane-scoped entries for the same file', () => {
    const cache = new Map([
      ['/a.pdf:pdf', position(4)],
      ['/a.pdf::tab-2:pdf', position(9)],
      ['/a.pdf::tab-3:pdf', position(11)]
    ])
    sweepClosedPdfViewPositions(cache, ['/a.pdf'])
    expect(cache.size).toBe(0)
  })

  it('leaves other files untouched', () => {
    const cache = new Map([
      ['/a.pdf:pdf', position(4)],
      ['/b.pdf:pdf', position(7)],
      ['/b.pdf::tab-2:pdf', position(8)]
    ])
    sweepClosedPdfViewPositions(cache, ['/a.pdf'])
    expect([...cache.keys()]).toEqual(['/b.pdf:pdf', '/b.pdf::tab-2:pdf'])
  })

  it('does not delete a different file that shares a path prefix', () => {
    const cache = new Map([
      ['/report.pdf:pdf', position(2)],
      ['/report.pdf.bak:pdf', position(3)]
    ])
    sweepClosedPdfViewPositions(cache, ['/report.pdf'])
    expect([...cache.keys()]).toEqual(['/report.pdf.bak:pdf'])
  })

  it('is a no-op when the file has no cached position', () => {
    const cache = new Map([['/b.pdf:pdf', position(7)]])
    sweepClosedPdfViewPositions(cache, ['/a.pdf'])
    expect(cache.size).toBe(1)
  })
})
