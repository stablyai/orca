import { deriveNativeChatRowContent } from '../../../../shared/native-chat/transcript/native-chat-row-content'
import { nativeChatProseToMarkdown } from '../../../../shared/native-chat/transcript/native-chat-prose'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import {
  DEFAULT_ROW_TYPOGRAPHY,
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

// The estimate caps at 1600px; larger source text must not add measurement work.
it.each([100_000, 1_000_000])('bounds height scanning for %i characters', (length) => {
  const row = message('x'.repeat(length))
  {
    const metrics = nativeChatRowContentMetrics(row)
    expect(
      estimateNativeChatRowHeight(metrics, {
        hasReceipt: false,
        hasStatus: false,
        hasTurnDiff: false
      })
    ).toBe(1600)
    // The same wrapping width with a different line height needs a fresh capped estimate.
    const small = { ...DEFAULT_ROW_TYPOGRAPHY, lineHeightPx: 16 }
    expect(
      estimateNativeChatRowHeight(
        nativeChatRowContentMetrics(row, small),
        {
          hasReceipt: false,
          hasStatus: false,
          hasTurnDiff: false
        },
        small
      )
    ).toBe(1600)
  }
})

it.each([
  [100_000, 200_002],
  [1_000_000, 2_000_002]
])('does not materialize full text for an offscreen %i-character block', (length, fullLength) => {
  const row = message('unused')
  row.blocks = [
    { type: 'text', text: 'a'.repeat(length) },
    { type: 'text', text: 'b'.repeat(length) }
  ]
  const content = deriveNativeChatRowContent(row.blocks)
  const full = Object.getOwnPropertyDescriptor(content, 'markdown')!.get!
  let reads = 0
  Object.defineProperty(content, 'markdown', {
    get: () => {
      reads++
      return full.call(content)
    }
  })
  const join = Array.prototype.join
  let joinedUnits = 0
  const joined = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator?: string
  ) {
    const output = join.call(this, separator)
    joinedUnits += output.length
    return output
  })
  let slots: ReturnType<typeof buildNativeChatTranscriptSlots>
  try {
    slots = buildNativeChatTranscriptSlots({
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
  } finally {
    joined.mockRestore()
  }
  expect(joinedUnits).toBeLessThanOrEqual(
    Math.max(
      601,
      Math.ceil(1600 / DEFAULT_ROW_TYPOGRAPHY.lineHeightPx) * DEFAULT_ROW_TYPOGRAPHY.charsPerLine
    )
  )
  expect(reads).toBe(0)
  expect(slots[0]?.estimatedHeight).toBe(1600)
  expect(content.markdown).toHaveLength(fullLength)
  expect(content.markdown.slice(length - 1, length + 3)).toBe('a\n\nb')
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
