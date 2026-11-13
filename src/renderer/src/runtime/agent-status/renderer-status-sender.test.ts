import { afterEach, expect, it, vi } from 'vitest'
import { RendererStatusSender } from './renderer-status-sender'
import type {
  RendererStatusAck,
  RendererStatusPublication,
  RendererStatusRecord
} from '../../../../shared/agent-status/renderer-status-publication'

vi.useFakeTimers()
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
  await vi.advanceTimersByTimeAsync(16)
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
