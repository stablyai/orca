import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfViewPosition } from '@/lib/scroll-cache'
import {
  buildPdfScrollDestination,
  clampPdfViewPosition,
  createPdfViewPositionRecorder,
  PDF_POSITION_FLUSH_MS,
  readPdfViewPosition
} from './pdf-view-position'

describe('readPdfViewPosition', () => {
  it('normalizes a well-formed updateviewarea location', () => {
    expect(
      readPdfViewPosition({ pageNumber: 12, top: 431, left: 62, scale: 1.5, rotation: 0 })
    ).toEqual({ pageNumber: 12, top: 431, left: 62 })
  })

  it('accepts negative offsets (inter-page gap positions)', () => {
    expect(readPdfViewPosition({ pageNumber: 3, top: -14, left: -2 })).toEqual({
      pageNumber: 3,
      top: -14,
      left: -2
    })
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 'page 12'],
    ['a number', 7]
  ])('returns null for %s', (_label, input) => {
    expect(readPdfViewPosition(input)).toBeNull()
  })

  it('returns null when top is missing', () => {
    expect(readPdfViewPosition({ pageNumber: 2, left: 0 })).toBeNull()
  })

  it('returns null when left is missing', () => {
    expect(readPdfViewPosition({ pageNumber: 2, top: 0 })).toBeNull()
  })

  it.each([
    ['NaN top', { pageNumber: 2, top: Number.NaN, left: 0 }],
    ['Infinity left', { pageNumber: 2, top: 0, left: Number.POSITIVE_INFINITY }],
    ['NaN pageNumber', { pageNumber: Number.NaN, top: 0, left: 0 }]
  ])('returns null for %s', (_label, input) => {
    expect(readPdfViewPosition(input)).toBeNull()
  })

  it('returns null for pageNumber 0', () => {
    expect(readPdfViewPosition({ pageNumber: 0, top: 0, left: 0 })).toBeNull()
  })

  it('returns null for a fractional pageNumber', () => {
    expect(readPdfViewPosition({ pageNumber: 2.5, top: 0, left: 0 })).toBeNull()
  })

  it('preserves a top-of-page-1 position verbatim', () => {
    // Why: `top` is a bottom-origin PDF coordinate, so the top of a Letter page
    // is ~792, not 0. Nothing may treat this as a "document start" sentinel.
    expect(readPdfViewPosition({ pageNumber: 1, top: 792, left: 0 })).toEqual({
      pageNumber: 1,
      top: 792,
      left: 0
    })
  })
})

describe('buildPdfScrollDestination', () => {
  it('emits the 5-element XYZ destArray with left and top in slots 2 and 3', () => {
    expect(buildPdfScrollDestination({ pageNumber: 12, top: 431, left: 62 })).toEqual({
      pageNumber: 12,
      destArray: [null, { name: 'XYZ' }, 62, 431, null],
      ignoreDestinationZoom: true,
      allowNegativeOffset: true
    })
  })

  it('always sets both flags', () => {
    const destination = buildPdfScrollDestination({ pageNumber: 1, top: 0, left: 0 })
    expect(destination.ignoreDestinationZoom).toBe(true)
    expect(destination.allowNegativeOffset).toBe(true)
  })
})

describe('clampPdfViewPosition', () => {
  const position = { pageNumber: 40, top: 100, left: 10 }

  it('clamps a page beyond the document to the last page', () => {
    expect(clampPdfViewPosition(position, 12)).toEqual({ pageNumber: 12, top: 100, left: 10 })
  })

  it('returns an in-range position untouched', () => {
    const inRange = { pageNumber: 5, top: 100, left: 10 }
    expect(clampPdfViewPosition(inRange, 12)).toBe(inRange)
  })

  it('returns null when the document reports no pages', () => {
    expect(clampPdfViewPosition(position, 0)).toBeNull()
  })

  it('returns null for a non-finite page count', () => {
    expect(clampPdfViewPosition(position, Number.NaN)).toBeNull()
  })

  it('preserves top and left while clamping the page', () => {
    const clamped = clampPdfViewPosition(position, 3)
    expect(clamped).toEqual({ pageNumber: 3, top: 100, left: 10 })
  })
})

describe('createPdfViewPositionRecorder', () => {
  let writes: [string, PdfViewPosition][]

  const makeRecorder = (key = 'a.pdf:pdf') =>
    createPdfViewPositionRecorder({
      key,
      write: (writtenKey, position) => writes.push([writtenKey, position])
    })

  const location = (pageNumber: number) => ({ pageNumber, top: 400, left: 20, scale: 1 })

  beforeEach(() => {
    writes = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores records before arm, so a pre-restore scroll cannot overwrite the cache', () => {
    const recorder = makeRecorder()
    recorder.record(location(1))
    vi.advanceTimersByTime(PDF_POSITION_FLUSH_MS * 2)
    recorder.dispose()
    expect(writes).toEqual([])
  })

  it('disposing without any record is a strict no-op (StrictMode double-mount)', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.dispose()
    expect(writes).toEqual([])
  })

  it('flushes the last recorded position on dispose', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(7))
    recorder.dispose()
    expect(writes).toEqual([['a.pdf:pdf', { pageNumber: 7, top: 400, left: 20 }]])
  })

  it('fires the debounced write once and reflects the latest of several rapid records', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(2))
    recorder.record(location(3))
    recorder.record(location(4))
    expect(writes).toEqual([])
    vi.advanceTimersByTime(PDF_POSITION_FLUSH_MS)
    expect(writes).toEqual([['a.pdf:pdf', { pageNumber: 4, top: 400, left: 20 }]])
  })

  // Why: the timer is deliberately trailing-from-first-record, not a restarting
  // debounce — a restarting one would starve the LRU refresh under continuous
  // scrolling, which is exactly when the entry most needs to stay warm.
  it('does not restart the pending timer when a later record arrives', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(2))
    vi.advanceTimersByTime(PDF_POSITION_FLUSH_MS - 50)
    recorder.record(location(3))
    vi.advanceTimersByTime(50)
    expect(writes).toEqual([['a.pdf:pdf', { pageNumber: 3, top: 400, left: 20 }]])
  })

  it('ignores a malformed location without clearing the last good position', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(5))
    recorder.record({ pageNumber: Number.NaN, top: 1, left: 1 })
    recorder.dispose()
    expect(writes.at(-1)).toEqual(['a.pdf:pdf', { pageNumber: 5, top: 400, left: 20 }])
  })

  it('only ever writes under the key it was constructed with', () => {
    const recorder = makeRecorder('b.pdf::tab-2:pdf')
    recorder.arm()
    recorder.record(location(9))
    recorder.dispose()
    expect(writes).toEqual([['b.pdf::tab-2:pdf', { pageNumber: 9, top: 400, left: 20 }]])
  })

  it('cancels the pending timer on dispose so teardown writes exactly once', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(6))
    recorder.dispose()
    vi.advanceTimersByTime(PDF_POSITION_FLUSH_MS * 2)
    expect(writes).toHaveLength(1)
  })

  it('record after dispose schedules no timer and writes nothing', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(6))
    recorder.dispose()
    recorder.record(location(99))
    vi.advanceTimersByTime(PDF_POSITION_FLUSH_MS * 2)
    expect(writes).toEqual([['a.pdf:pdf', { pageNumber: 6, top: 400, left: 20 }]])
  })

  it('disposing twice does not write twice', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(6))
    recorder.dispose()
    recorder.dispose()
    expect(writes).toHaveLength(1)
  })
})
