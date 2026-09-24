import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import {
  buildNativeChatRailItems,
  mergeNativeChatRailOutline,
  selectNativeChatRailTicks,
  NATIVE_CHAT_RAIL_MAX_TICKS,
  type NativeChatRailItem
} from './native-chat-message-rail-items'

function text(id: string, body: string, role: NativeChatMessage['role'] = 'assistant') {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text: body }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function image(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'image-ref' as const, path: '/tmp/shot.png' }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function slotsOf(messages: NativeChatMessage[]) {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    latestUserIndex: messages.findLastIndex((message) => message.role === 'user'),
    currentTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    showTurnStatus: false,
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  })
}

function railItems(count: number): NativeChatRailItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `m${index}`,
    slotIndex: index,
    text: `m${index}`,
    hasImages: false
  }))
}

describe('rail items', () => {
  it('invalidates cached previews and positions after edits, prepends and removals', () => {
    const prompt = text('u1', 'original prompt', 'user')
    const first = buildNativeChatRailItems(slotsOf([prompt]))
    const prepended = buildNativeChatRailItems(
      slotsOf([text('a0', 'earlier reply'), prompt]),
      first
    )
    expect(prepended[0]).toEqual({ ...first[0], slotIndex: 1 })
    const edited = buildNativeChatRailItems(
      slotsOf([text('u1', 'edited prompt', 'user')]),
      prepended
    )
    expect(edited[0]).toEqual({ ...first[0], text: 'edited prompt' })
    expect(buildNativeChatRailItems([], edited)).toEqual([])
  })

  it('ticks only the user messages', () => {
    const items = buildNativeChatRailItems(
      slotsOf([
        text('u1', 'first ask', 'user'),
        text('a1', 'agent reply'),
        text('u2', 'second ask', 'user')
      ])
    )
    expect(items.map((item) => item.id)).toEqual(['u1', 'u2'])
  })

  // The rail points at a row, and the virtualizer counts slots — so an entry has
  // to carry the slot index. A message that draws nothing takes no slot, which
  // is exactly where a message index would start lying.
  it('indexes by slot, not by message position', () => {
    const items = buildNativeChatRailItems(slotsOf([text('blank', ''), text('u1', 'ask', 'user')]))
    expect(items).toHaveLength(1)
    expect(items[0]?.slotIndex).toBe(0)
  })

  it('collapses whitespace in the preview', () => {
    const items = buildNativeChatRailItems(slotsOf([text('u1', '  a\n\n  b  ', 'user')]))
    expect(items[0]?.text).toBe('a b')
  })

  it('reports an image-only message as having no prose', () => {
    const items = buildNativeChatRailItems(slotsOf([image('u1')]))
    expect(items[0]?.text).toBe('')
    expect(items[0]?.hasImages).toBe(true)
  })
})

describe('rail tick sampling', () => {
  it('keeps every tick while the thread fits', () => {
    const items = railItems(NATIVE_CHAT_RAIL_MAX_TICKS)
    expect(selectNativeChatRailTicks({ items, activeId: null })).toBe(items)
  })

  it('caps a long thread and keeps both ends', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, activeId: null })
    expect(ticks).toHaveLength(NATIVE_CHAT_RAIL_MAX_TICKS)
    expect(ticks[0]?.id).toBe('m0')
    expect(ticks.at(-1)?.id).toBe('m119')
  })

  it('always includes the active tick', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, activeId: 'm7' })
    expect(ticks.map((tick) => tick.id)).toContain('m7')
    expect(ticks).toHaveLength(NATIVE_CHAT_RAIL_MAX_TICKS)
  })

  // Losing an end would make the rail claim the conversation starts or stops
  // somewhere it doesn't, so the eviction has to fall on a neighbour instead.
  it('evicts a neighbour rather than an end when the active tick is near one', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, activeId: 'm1' })
    const ids = ticks.map((tick) => tick.id)
    expect(ids).toContain('m0')
    expect(ids).toContain('m1')
    expect(ids).toContain('m119')
  })

  it('returns ticks in thread order', () => {
    const ticks = selectNativeChatRailTicks({ items: railItems(120), activeId: 'm63' })
    const indexes = ticks.map((tick) => tick.slotIndex ?? -1)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  })
})

describe('rail outline merge', () => {
  const loaded = [
    { id: 'u3', slotIndex: 0, text: 'third', hasImages: false },
    { id: 'u4', slotIndex: 2, text: 'fourth', hasImages: false }
  ]

  it('puts outline entries first in outline order, with no slot', () => {
    const merged = mergeNativeChatRailOutline(
      [
        { id: 'u1', text: 'first', hasImages: false },
        { id: 'u2', text: '', hasImages: true }
      ],
      loaded
    )
    expect(merged).toEqual([
      { id: 'u1', slotIndex: null, text: 'first', hasImages: false },
      { id: 'u2', slotIndex: null, text: '', hasImages: true },
      ...loaded
    ])
  })

  it('lets a loaded item replace its outline entry, keeping the loaded slot', () => {
    const merged = mergeNativeChatRailOutline(
      [
        { id: 'u1', text: 'first', hasImages: false },
        { id: 'u3', text: 'stale preview', hasImages: false }
      ],
      loaded
    )
    expect(merged.map((item) => [item.id, item.slotIndex, item.text])).toEqual([
      ['u1', null, 'first'],
      ['u3', 0, 'third'],
      ['u4', 2, 'fourth']
    ])
  })

  it('is the loaded list itself when there is no outline to add', () => {
    expect(mergeNativeChatRailOutline(null, loaded)).toBe(loaded)
    expect(mergeNativeChatRailOutline([], loaded)).toBe(loaded)
    expect(mergeNativeChatRailOutline([{ id: 'u3', text: 'x', hasImages: false }], loaded)).toBe(
      loaded
    )
  })
})
