import { describe, expect, it } from 'vitest'

import type { QueueEntry } from './pane-terminal-output-queue-registry'
import { enqueueChunk, takeQueuedChunk } from './pane-terminal-output-queue-chunks'

function createEntry(): QueueEntry {
  return {
    terminal: {} as QueueEntry['terminal'],
    chunks: [],
    chunkIndex: 0,
    queuedChars: 0,
    backgroundBacklogDropped: false,
    highPriority: false,
    foregroundHold: false,
    foregroundHoldSafetyDelayMs: 0,
    foregroundCoalesce: false,
    foregroundCoalesceDelayMs: 0,
    foregroundHoldSafetyTimer: null,
    foregroundCoalesceTimer: null,
    foregroundReleaseDeadlineAt: null,
    foregroundReleaseDeadlineFixed: false
  }
}

describe('pane terminal output queue chunks', () => {
  it('assembles many queued chunks in order and preserves a partial residual', () => {
    const entry = createEntry()
    const chunks = Array.from({ length: 128 }, (_, index) => `${index}:`)
    for (const chunk of chunks) {
      enqueueChunk(entry, chunk, { foreground: false })
    }

    const allData = chunks.join('')
    const first = takeQueuedChunk(entry, allData.length - 2)
    expect(first?.data).toBe(allData.slice(0, -2))
    expect(entry.queuedChars).toBe(2)

    const second = takeQueuedChunk(entry, 2)
    expect(second?.data).toBe(allData.slice(-2))
    expect(entry.queuedChars).toBe(0)
  })
})
