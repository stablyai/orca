import { describe, expect, it } from 'vitest'
import type { AgentSessionConversationOutline } from '../../../../shared/agent-session-conversation-outline'
import { selectStructuredRailOutline } from './structured-agent-session-rail-outline'

function outline(
  through: number,
  sequences: number[],
  epoch = 'epoch-1'
): AgentSessionConversationOutline {
  return {
    sessionId: 'session-1',
    cursor: { epoch, sequence: through },
    entries: sequences.map((sequence) => ({
      itemId: `user-${sequence}`,
      sequence,
      preview: `prompt ${sequence}`,
      imageCount: sequence === 1 ? 2 : 0
    })),
    omittedEntries: 0
  }
}

const WINDOW = { epoch: 'epoch-1', oldestLoadedSequence: 50, hasOlder: true }

describe('structured rail outline selection', () => {
  it('needs no outline when nothing older is unloaded', () => {
    expect(
      selectStructuredRailOutline(outline(90, [1, 60]), { ...WINDOW, hasOlder: false })
    ).toEqual({ kind: 'complete' })
    expect(selectStructuredRailOutline(null, { ...WINDOW, oldestLoadedSequence: null })).toEqual({
      kind: 'complete'
    })
  })

  it('uses only the entries older than the loaded window, which is authoritative for the rest', () => {
    const view = selectStructuredRailOutline(outline(90, [1, 20, 49, 50, 70]), WINDOW)
    expect(view).toEqual({
      kind: 'fresh',
      entries: [
        { id: 'user-1', text: 'prompt 1', hasImages: true },
        { id: 'user-20', text: 'prompt 20', hasImages: false },
        { id: 'user-49', text: 'prompt 49', hasImages: false }
      ]
    })
  })

  it('is stale, and so unused, while no outline has arrived', () => {
    expect(selectStructuredRailOutline(null, WINDOW)).toEqual({ kind: 'stale' })
  })

  it('is stale across an epoch change', () => {
    expect(selectStructuredRailOutline(outline(90, [1], 'epoch-0'), WINDOW)).toEqual({
      kind: 'stale'
    })
  })

  it('is stale when the loaded window has moved past what the outline covers', () => {
    // Covers through 48; the window starts at 50, so a message created at 49 has no source.
    expect(selectStructuredRailOutline(outline(48, [1]), WINDOW)).toEqual({ kind: 'stale' })
    // Covers through 49: the two sources abut, nothing is missing.
    expect(selectStructuredRailOutline(outline(49, [1]), WINDOW).kind).toBe('fresh')
  })

  it('hands the rail one entries array until the window edge moves', () => {
    const value = outline(90, [1, 20, 49])
    const first = selectStructuredRailOutline(value, WINDOW)
    expect(selectStructuredRailOutline(value, { ...WINDOW })).toBe(first)
    const paged = selectStructuredRailOutline(value, { ...WINDOW, oldestLoadedSequence: 20 })
    expect(paged).not.toBe(first)
    expect(paged).toMatchObject({ kind: 'fresh', entries: [{ id: 'user-1' }] })
  })

  it('keeps the same entries while a trimmed live window moves its edge past no user message', () => {
    const value = outline(200, [1, 20, 49, 80])
    const first = selectStructuredRailOutline(value, WINDOW)
    // Each new live row head-trims the window by one; none of these edges uncovers an entry.
    for (const oldestLoadedSequence of [51, 60, 80]) {
      expect(selectStructuredRailOutline(value, { ...WINDOW, oldestLoadedSequence })).toBe(first)
    }
    const passed = selectStructuredRailOutline(value, { ...WINDOW, oldestLoadedSequence: 81 })
    expect(passed).toMatchObject({ kind: 'fresh', entries: [{}, {}, {}, { id: 'user-80' }] })
  })
})
