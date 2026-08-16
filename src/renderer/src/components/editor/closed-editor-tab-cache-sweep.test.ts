import { describe, expect, it } from 'vitest'
import type { PdfViewPosition } from '@/lib/scroll-cache'
import { sweepClosedPdfViewPositions } from './closed-editor-tab-cache-sweep'

const position = (pageNumber: number): PdfViewPosition => ({ pageNumber, top: 0, left: 0 })

describe('sweepClosedPdfViewPositions', () => {
  it('deletes the unscoped :pdf entry', () => {
    const cache = new Map([['/a.pdf:pdf', position(4)]])
    sweepClosedPdfViewPositions(cache, '/a.pdf')
    expect(cache.size).toBe(0)
  })

  it('deletes pane-scoped entries for the same file', () => {
    const cache = new Map([
      ['/a.pdf:pdf', position(4)],
      ['/a.pdf::tab-2:pdf', position(9)],
      ['/a.pdf::tab-3:pdf', position(11)]
    ])
    sweepClosedPdfViewPositions(cache, '/a.pdf')
    expect(cache.size).toBe(0)
  })

  it('leaves other files untouched', () => {
    const cache = new Map([
      ['/a.pdf:pdf', position(4)],
      ['/b.pdf:pdf', position(7)],
      ['/b.pdf::tab-2:pdf', position(8)]
    ])
    sweepClosedPdfViewPositions(cache, '/a.pdf')
    expect([...cache.keys()]).toEqual(['/b.pdf:pdf', '/b.pdf::tab-2:pdf'])
  })

  it('does not delete a different file that shares a path prefix', () => {
    const cache = new Map([
      ['/report.pdf:pdf', position(2)],
      ['/report.pdf.bak:pdf', position(3)]
    ])
    sweepClosedPdfViewPositions(cache, '/report.pdf')
    expect([...cache.keys()]).toEqual(['/report.pdf.bak:pdf'])
  })

  it('is a no-op when the file has no cached position', () => {
    const cache = new Map([['/b.pdf:pdf', position(7)]])
    sweepClosedPdfViewPositions(cache, '/a.pdf')
    expect(cache.size).toBe(1)
  })
})
