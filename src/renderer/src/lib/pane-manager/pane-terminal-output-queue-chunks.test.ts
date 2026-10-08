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
    foregroundReleaseDeadlineFixed: false,
    foregroundHoldSafetyExtended: false
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

  it('does not cut a queued chunk inside an open DEC 2026 frame', () => {
    const entry = createEntry()
    const open = '\x1b[?2026h'
    const close = '\x1b[?2026l'
    const firstFrame = `${open}aaaa${close}`
    const data = `${firstFrame}${open}bbbbbbbbbbbb${close}`
    enqueueChunk(entry, data, { foreground: true })

    // A limit landing inside the second frame must stop after the first one:
    // xterm paints nothing while the latch is open, so stranding the close in
    // the residual freezes the pane until a later drain or its 1000ms timeout.
    const taken = takeQueuedChunk(entry, firstFrame.length + 6)
    expect(taken?.data).toBe(firstFrame)
    // The residual keeps the rest, byte-exact, with accounting still balanced.
    const rest = takeQueuedChunk(entry, data.length)
    expect(`${taken?.data ?? ''}${rest?.data ?? ''}`).toBe(data)
    expect(entry.queuedChars).toBe(0)
  })
})
