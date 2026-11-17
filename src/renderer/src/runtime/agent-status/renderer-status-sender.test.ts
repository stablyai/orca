import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RendererStatusSender } from './renderer-status-sender'
import type {
  RendererStatusAck,
  RendererStatusPublication,
  RendererStatusRecord
} from '../../../../shared/agent-status/renderer-status-publication'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('preserves post-capture changes and binding removals across an in-flight snapshot and resync', async () => {
  let current: RendererStatusRecord = {
    paneKey: 'tab:leaf',
    leafId: 'leaf',
    rendererPtyId: 'A',
    row: {
      state: 'working',
      prompt: 'first',
      updatedAt: 10,
      stateStartedAt: 10,
      stateHistory: [],
      paneKey: 'tab:leaf'
    }
  }
  const batches: RendererStatusPublication[] = []
  let acknowledge: ((ack: RendererStatusAck) => void) | undefined
  const cursor = { seq: 0 }
  const sender = new RendererStatusSender(
    'renderer',
    () => current,
    () => ['tab:leaf'],
    (batch) => {
      batches.push(batch)
      return new Promise((resolve) => {
        acknowledge = resolve
      })
    },
    cursor
  )
  sender.graphAccepted()
  await vi.advanceTimersByTimeAsync(16)
  current = { ...current, rendererPtyId: 'B', row: { ...current.row!, prompt: 'latest' } }
  sender.changed(new Set(['tab:leaf']))
  acknowledge!({ accepted: true })
  await vi.advanceTimersByTimeAsync(16)
  expect(batches.map((batch) => [batch.type, batch.seq])).toEqual([
    ['snapshot', 1],
    ['changes', 2]
  ])
  expect(batches[0].rows[0].row?.prompt).toBe('first')
  expect(
    batches[1].rows.map((record) => [record.rendererPtyId, record.row?.prompt ?? null])
  ).toEqual([
    ['A', null],
    ['B', 'latest']
  ])
  acknowledge!({ accepted: false, snapshotRequired: true })
  await vi.advanceTimersToNextTimerAsync()
  expect(batches[2]).toMatchObject({
    type: 'snapshot',
    seq: 3,
    rows: [{ rendererPtyId: 'B', row: { prompt: 'latest' } }]
  })
  acknowledge!({ accepted: true })
  sender.stop()
  const restarted = new RendererStatusSender(
    'renderer',
    () => current,
    () => ['tab:leaf'],
    async (batch) => {
      batches.push(batch)
      return { accepted: true }
    },
    cursor
  )
  restarted.graphAccepted()
  await vi.advanceTimersByTimeAsync(16)
  expect(batches[3]).toMatchObject({ type: 'snapshot', seq: 4 })
  restarted.stop()
})

it('recovers a rejected Promise with a snapshot and re-arms a superseded sender on the next accepted graph', async () => {
  const batches: RendererStatusPublication[] = []
  let attempt = 0
  const send = vi.fn(async (batch: RendererStatusPublication): Promise<RendererStatusAck> => {
    batches.push(batch)
    if (++attempt === 1) {
      throw new Error('IPC unavailable')
    }
    return attempt === 3 ? { accepted: false, reason: 'superseded' } : { accepted: true }
  })
  const requestGraph = vi.fn()
  const sender = new RendererStatusSender(
    'old',
    () => null,
    () => [],
    send,
    { seq: 0 },
    requestGraph
  )
  sender.changed(null)
  expect(requestGraph).toHaveBeenCalledTimes(1)
  sender.graphAccepted()
  await vi.advanceTimersToNextTimerAsync()
  await vi.advanceTimersToNextTimerAsync()
  expect(batches.map((batch) => batch.type)).toEqual(['snapshot', 'snapshot'])
  sender.changed(null)
  expect(requestGraph).toHaveBeenCalledTimes(1)
  await vi.advanceTimersToNextTimerAsync()
  sender.changed(null)
  await vi.runAllTimersAsync()
  expect(send).toHaveBeenCalledTimes(3)
  expect(requestGraph).toHaveBeenCalledTimes(2)
  sender.graphAccepted()
  await vi.runAllTimersAsync()
  expect(batches.map((batch) => batch.type)).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
    'snapshot'
  ])
  sender.stop()
})

it('sends a row again only when it changed since the last one sent', async () => {
  const row = {
    state: 'working' as const,
    prompt: 'first',
    updatedAt: 10,
    stateStartedAt: 10,
    stateHistory: [],
    paneKey: 'tab:leaf'
  }
  let current: RendererStatusRecord = {
    paneKey: 'tab:leaf',
    leafId: 'leaf',
    rendererPtyId: 'A',
    row
  }
  const batches: RendererStatusPublication[] = []
  const sender = new RendererStatusSender(
    'renderer',
    () => current,
    () => ['tab:leaf'],
    async (batch) => {
      batches.push(batch)
      return { accepted: true }
    }
  )
  sender.graphAccepted()
  await vi.runAllTimersAsync()
  current = { ...current, row: { ...row } }
  sender.changed(new Set(['tab:leaf']))
  await vi.runAllTimersAsync()
  current = { ...current, row: { ...row, prompt: 'second' } }
  sender.changed(new Set(['tab:leaf']))
  await vi.runAllTimersAsync()
  expect(
    batches.map((batch) => [batch.type, batch.rows.map((record) => record.row?.prompt)])
  ).toEqual([
    ['snapshot', ['first']],
    ['changes', ['second']]
  ])
  sender.stop()
})
