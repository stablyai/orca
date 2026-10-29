import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { reportWorkerTakeoverOncePerWindow } from './worker-terminal-takeover-report-gate'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
})
afterEach(() => vi.useRealTimers())

it('reports each key once per 30 second window', () => {
  const gate = new Map<string, number>()
  const send = vi.fn().mockResolvedValue(undefined)
  for (let i = 0; i < 100; i++) {
    reportWorkerTakeoverOncePerWindow(gate, 'term-1', send)
  }
  reportWorkerTakeoverOncePerWindow(gate, 'term-2', send)
  expect(send).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(29_999)
  reportWorkerTakeoverOncePerWindow(gate, 'term-1', send)
  expect(send).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(1)
  reportWorkerTakeoverOncePerWindow(gate, 'term-1', send)
  expect(send).toHaveBeenCalledTimes(3)
})

it('retries a failed report once, then lets the next input report again', async () => {
  const gate = new Map<string, number>()
  const send = vi.fn().mockRejectedValue(new Error('offline'))
  reportWorkerTakeoverOncePerWindow(gate, 'term-1', send)
  await vi.advanceTimersByTimeAsync(249)
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(send).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(send).toHaveBeenCalledTimes(2)
  send.mockResolvedValue(undefined)
  reportWorkerTakeoverOncePerWindow(gate, 'term-1', send)
  expect(send).toHaveBeenCalledTimes(3)
})
