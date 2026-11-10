import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfViewPosition } from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import { createPdfViewPositionRecorder, PDF_POSITION_FLUSH_MS } from './pdf-view-position'

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

  it('flushes the last recorded position on dispose', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(7))
    recorder.dispose()
    expect(writes).toEqual([['a.pdf:pdf', { pageNumber: 7, top: 400, left: 20 }]])
  })

  // Restarting the timer would starve LRU refresh during continuous scrolling, when the entry most needs to stay warm.

  it('ignores a malformed location without clearing the last good position', () => {
    const recorder = makeRecorder()
    recorder.arm()
    recorder.record(location(5))
    recorder.record({ pageNumber: Number.NaN, top: 1, left: 1 })
    recorder.dispose()
    expect(writes.at(-1)).toEqual(['a.pdf:pdf', { pageNumber: 5, top: 400, left: 20 }])
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
})
