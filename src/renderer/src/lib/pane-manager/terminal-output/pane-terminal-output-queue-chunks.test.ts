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
  it('does not cut a queued chunk inside an open DEC 2026 frame', () => {
    const entry = createEntry()
    const open = '\x1b[?2026h'
    const close = '\x1b[?2026l'
    const firstFrame = `${open}aaaa${close}`
    const data = `${firstFrame}${open}bbbbbbbbbbbb${close}`
    enqueueChunk(entry, data, { foreground: true })

    // Stop after the first complete frame: a cut inside the next strands its close marker and freezes painting until drain/1000ms timeout.
    const taken = takeQueuedChunk(entry, firstFrame.length + 6)
    expect(taken?.data).toBe(firstFrame)
    const rest = takeQueuedChunk(entry, data.length)
    expect(`${taken?.data ?? ''}${rest?.data ?? ''}`).toBe(data)
    expect(entry.queuedChars).toBe(0)
  })

  it('defers forceForegroundRefresh until the final slice when splitting an oversized chunk', () => {
    const entry = createEntry()
    enqueueChunk(entry, 'a'.repeat(32), {
      foreground: true,
      forceForegroundRefresh: true,
      followupForegroundRefresh: true
    })

    const firstSlice = takeQueuedChunk(entry, 16)
    expect(firstSlice?.data.length).toBe(16)
    expect(firstSlice?.forceForegroundRefresh).toBe(false)
    expect(firstSlice?.followupForegroundRefresh).toBe(false)

    const finalSlice = takeQueuedChunk(entry, 16)
    expect(finalSlice?.data.length).toBe(16)
    expect(finalSlice?.forceForegroundRefresh).toBe(true)
    expect(finalSlice?.followupForegroundRefresh).toBe(true)
    expect(entry.queuedChars).toBe(0)
  })
})
