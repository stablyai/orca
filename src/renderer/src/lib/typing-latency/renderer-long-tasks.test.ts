import { afterEach, expect, it, vi } from 'vitest'

import type { ExactEchoSample } from './echo-observation'
import { observeRendererLongTasks, summarizeLongTaskOverlap } from './renderer-long-tasks'

function sample(startedAt: number, paintedAt: number): ExactEchoSample {
  return {
    attribution: 'single-input',
    source: 'direct',
    inputToDispatchMs: 0,
    dispatchToParseMs: 0,
    parseToPaintMs: 0,
    inputToPaintMs: paintedAt - startedAt,
    eventToHandlerMs: 0,
    eventToPaintMs: paintedAt - startedAt,
    dispatchToArrivalMs: null,
    arrivalToWriteMs: null,
    writeToParseMs: null,
    startedAt,
    paintedAt,
    outputBytes: 1,
    outputWrites: 1
  }
}

afterEach(() => vi.unstubAllGlobals())

it('marks echoes with evicted task history incomplete, including tasks drained on stop', () => {
  type Entry = { startTime: number; duration: number }
  let deliver = (_entries: Entry[]): void => undefined
  const pending: Entry[] = []
  vi.stubGlobal(
    'PerformanceObserver',
    class {
      static supportedEntryTypes = ['long-animation-frame']
      constructor(callback: (list: { getEntries: () => Entry[] }) => void) {
        deliver = (entries) => callback({ getEntries: () => entries })
      }
      observe(): void {}
      disconnect(): void {}
      takeRecords(): Entry[] {
        return pending.splice(0)
      }
    }
  )
  const log = observeRendererLongTasks()
  deliver(Array.from({ length: 600 }, (_, i) => ({ startTime: i * 100, duration: 60 })))
  pending.push({ startTime: 60_000, duration: 60 })
  log.dispose()

  const report = summarizeLongTaskOverlap(
    log.source,
    log.tasks,
    [sample(0, 90), sample(10_050, 10_150), sample(10_060, 10_090), sample(60_000, 60_070)],
    log
  )
  expect(report).toMatchObject({
    observedTasks: 500,
    droppedTasks: 101,
    exactSamples: 4,
    incompleteExactSamples: 2,
    exactSamplesOverlapped: 1,
    overlapMs: { count: 2, p50: 0, p95: 60, max: 60 }
  })
  expect(report.slowestExactSamples.map((entry) => entry.longTaskOverlapMs)).toEqual([
    null,
    null,
    60,
    0
  ])
})
