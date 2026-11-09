import { describe, expect, it } from 'vitest'
import type { AgentSessionConversationOutline } from '../../../../../../shared/agent-session/agent-session-conversation-outline'
import { selectStructuredRailOutline } from './structured-agent-session-rail-outline'

function outline(
  through: number,
  sequences: number[],
  epoch = 'epoch-1'
): AgentSessionConversationOutline {
  return {
    sessionId: 'session-1',
    humanMessagesOnly: true,
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

const WINDOW = { epoch: 'epoch-1', oldestLoadedSequence: 50, hasOlder: true, contextFloor: 0 }

describe('structured rail outline selection', () => {
  it('lists nothing from before the latest /clear, which the transcript no longer shows', () => {
    const value = outline(90, [1, 20, 49])
    expect(selectStructuredRailOutline(value, WINDOW)).toMatchObject({ entries: [{}, {}, {}] })
    expect(selectStructuredRailOutline(value, { ...WINDOW, contextFloor: 20 })).toEqual({
      kind: 'fresh',
      entries: [{ id: 'user-49', text: 'prompt 49', hasImages: false }]
    })
  })

  it('is stale when the loaded window has moved past what the outline covers', () => {
    // Covers through 48; the window starts at 50, so a message created at 49 has no source.
    expect(selectStructuredRailOutline(outline(48, [1]), WINDOW)).toEqual({ kind: 'stale' })
    // Covers through 49: the two sources abut, nothing is missing.
    expect(selectStructuredRailOutline(outline(49, [1]), WINDOW).kind).toBe('fresh')
  })
})

it('does not reuse an old cached outline whose entries have no author guarantee', () => {
  const current = outline(90, [1, 20])
  expect(selectStructuredRailOutline(current, WINDOW)).toMatchObject({
    kind: 'fresh',
    entries: [{}, {}]
  })
  const { humanMessagesOnly: _marker, ...legacy } = current
  expect(selectStructuredRailOutline(legacy, WINDOW)).toEqual({ kind: 'unattributed' })
  expect(selectStructuredRailOutline(legacy, { ...WINDOW, oldestLoadedSequence: 60 })).toEqual({
    kind: 'unattributed'
  })
})
