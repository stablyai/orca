import { describe, expect, it } from 'vitest'
import {
  createRuntimeUploadProgressTracker,
  sumSourceUploadBytes
} from './runtime-upload-progress-tracker'

describe('sumSourceUploadBytes', () => {
  it('counts file bytes and ignores directory entries', () => {
    expect(
      sumSourceUploadBytes({
        entries: [
          { kind: 'directory' },
          { kind: 'file', byteLength: 10 },
          { kind: 'directory' },
          { kind: 'file', byteLength: 32 }
        ]
      })
    ).toBe(42)
  })

  it('is zero for a source of only empty files', () => {
    expect(sumSourceUploadBytes({ entries: [{ kind: 'file', byteLength: 0 }] })).toBe(0)
  })

  it('is zero for a source with no entries at all', () => {
    expect(sumSourceUploadBytes({})).toBe(0)
  })
})

describe('createRuntimeUploadProgressTracker', () => {
  it('carries completed files into the running total', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(300, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(50, 0)
    tracker.reportFileProgress(100, 0)
    tracker.completeFile(100)
    tracker.beginFile(1)
    tracker.reportFileProgress(75, 1)

    expect(seen).toEqual([50, 100, 175])
  })

  it('reports the same total on every update', () => {
    const totals: number[] = []
    const tracker = createRuntimeUploadProgressTracker(500, (p) => totals.push(p.totalBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(10, 0)
    // completeFile does not re-emit: the figure has not moved.
    tracker.completeFile(10)
    tracker.beginFile(1)
    tracker.reportFileProgress(20, 1)

    expect(totals).toEqual([500, 500])
  })

  it('does not repeat a figure that has not moved', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(40, 0)
    tracker.reportFileProgress(40, 0)
    tracker.completeFile(40)

    expect(seen).toEqual([40])
  })

  it('clamps to the staged total when a source grew after staging', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(250, 0)

    expect(seen).toEqual([100])
  })

  it('advances across a directory of several files', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(30, (p) => seen.push(p.sentBytes))

    for (const [sequence, size] of [10, 10, 10].entries()) {
      tracker.beginFile(sequence)
      tracker.reportFileProgress(size, sequence)
      tracker.completeFile(size)
    }

    expect(seen).toEqual([10, 20, 30])
  })

  it('ignores a progress event that lands after the file completed', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(40, 0)
    tracker.completeFile(40)
    // Electron does not order webContents.send against the invoke reply, so the
    // last chunk's event can arrive here; counting it would double the file.
    tracker.reportFileProgress(40, 0)

    expect(seen).toEqual([40])
  })

  it('ignores a late event from the previous file once the next file began', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(40, 0)
    tracker.completeFile(40)
    tracker.beginFile(1)
    // File 0's last event, delivered after file 1 opened the gate.
    tracker.reportFileProgress(40, 0)
    tracker.reportFileProgress(5, 1)

    expect(seen).toEqual([40, 45])
  })

  it('ignores an event that carries no file sequence', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.beginFile(0)
    tracker.reportFileProgress(40, undefined)

    expect(seen).toEqual([])
  })

  it('emits nothing before the first file begins', () => {
    const seen: number[] = []
    const tracker = createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    tracker.reportFileProgress(50, 0)

    expect(seen).toEqual([])
  })

  it('emits nothing until bytes move', () => {
    const seen: number[] = []
    createRuntimeUploadProgressTracker(100, (p) => seen.push(p.sentBytes))

    expect(seen).toEqual([])
  })
})
