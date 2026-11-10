import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import { nativeChatProseToMarkdown } from '../../../../../../shared/native-chat/transcript/native-chat-prose'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

function message(text: string, role: NativeChatMessage['role'] = 'assistant'): NativeChatMessage {
  return {
    id: `m-${text.length}`,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('transcript row height estimate', () => {
  it('keeps role-specific chrome when two messages share their blocks', () => {
    const blocks: NativeChatMessage['blocks'] = [{ type: 'text', text: 'same content' }]
    const withRole = (role: NativeChatMessage['role']): NativeChatMessage => ({
      ...message('same content', role),
      blocks
    })

    expect(nativeChatRowContentMetrics(withRole('user')).role).toBe('user')
    expect(nativeChatRowContentMetrics(withRole('assistant')).role).toBe('assistant')
  })
})

it('keeps complete multi-block markdown while estimating a capped row', () => {
  const row = message('unused')
  row.blocks = [
    { type: 'text', text: 'a'.repeat(100_000) },
    { type: 'text', text: 'b'.repeat(100_000) }
  ]
  const slots = buildNativeChatTranscriptSlots({
    messages: [row],
    turnKeys: ['turn'],
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
  expect(slots[0]?.estimatedHeight).toBe(1600)
  const content = deriveNativeChatRowContent(row.blocks)
  expect(content.markdown).toHaveLength(200_002)
  expect(content.markdown.slice(99_999, 100_003)).toBe('a\n\nb')
})

it('keeps short multi-block estimates, fold boundaries and complete markdown exact', () => {
  for (const [length, folded, height] of [
    [600, false, 230],
    [601, true, 232]
  ] as const) {
    const row = message('unused', 'user')
    row.blocks = [
      { type: 'text', text: 'x'.repeat(299) },
      { type: 'text', text: '' },
      { type: 'text', text: 'y'.repeat(length - 301) }
    ]
    const metrics = nativeChatRowContentMetrics(row)
    expect(metrics.userFolds).toBe(folded)
    expect(
      estimateNativeChatRowHeight(metrics, {
        hasReceipt: false,
        hasStatus: false,
        hasTurnDiff: false
      })
    ).toBe(height)
    expect(deriveNativeChatRowContent(row.blocks).markdown).toHaveLength(length)
  }
  const parts = [
    { type: 'text' as const, text: 'a' },
    { type: 'text' as const, text: '' },
    { type: 'text' as const, text: 'bc' }
  ]
  expect(nativeChatProseToMarkdown(parts, 2)).toBe('a\n')
  expect(nativeChatProseToMarkdown(parts, 4)).toBe('a\n\nb')
  expect(nativeChatProseToMarkdown(parts)).toBe('a\n\nbc')
})
