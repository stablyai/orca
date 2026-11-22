import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RendererStatusSender } from './renderer-status-sender'
import type {
  RendererStatusPublication,
  RendererStatusRecord
} from '../../../../shared/agent-status/renderer-status-publication'

// Perf contract (#43350): every hook event rewrites its tab, which reports every pane key on it, and the sender
// re-sent rows that hadn't changed. At fleet scale that flooded main with frames carrying nothing new.

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function record(paneKey: string, prompt: string): RendererStatusRecord {
  return {
    paneKey,
    leafId: 'leaf',
    rendererPtyId: `pty-${paneKey}`,
    row: { state: 'working', prompt, updatedAt: 10, stateStartedAt: 10, stateHistory: [], paneKey }
  }
}

it('sends nothing for 50 rounds of unchanged rows across 200 panes, then only the row that changed', async () => {
  const keys = Array.from({ length: 200 }, (_, index) => `tab-${index}:leaf`)
  const records = new Map(keys.map((key) => [key, record(key, 'first')]))
  const batches: RendererStatusPublication[] = []
  const sender = new RendererStatusSender(
    'renderer',
    (key) => records.get(key) ?? null,
    () => keys,
    async (batch) => {
      batches.push(batch)
      return { accepted: true }
    }
  )
  sender.graphAccepted()
  await vi.runAllTimersAsync()

  for (let round = 0; round < 50; round += 1) {
    // A restamp-only rewrite: new objects, same values.
    for (const key of keys) {
      records.set(key, record(key, 'first'))
    }
    sender.changed(new Set(keys))
    await vi.runAllTimersAsync()
  }
  records.set('tab-7:leaf', record('tab-7:leaf', 'second'))
  sender.changed(new Set(keys))
  await vi.runAllTimersAsync()

  expect(batches.map((batch) => [batch.type, batch.rows.length])).toEqual([
    ['snapshot', 200],
    ['changes', 1]
  ])
  sender.stop()
})
