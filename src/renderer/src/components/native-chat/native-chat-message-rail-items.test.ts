import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import {
  buildNativeChatRailItems,
  mergeNativeChatRailOutline,
  nativeChatRailReplyPreview,
  nativeChatRailTickCapacity,
  selectNativeChatRailTicks,
  NATIVE_CHAT_RAIL_ROOMY_TICKS,
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
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
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

describe('rail reply preview', () => {
  const outline = [
    { id: 'old-1', text: 'first', hasImages: false, reply: 'Host reply 1' },
    { id: 'old-2', text: 'second', hasImages: false, reply: 'Host reply 2, cut off early' }
  ]
  const rowsOf = (messages: NativeChatMessage[], turnKeys: (string | undefined)[]) => ({
    messages,
    turnKeys
  })

  it("reads a loaded message its turn's reply, past a steer into the same turn", () => {
    const rows = rowsOf(
      [
        text('u1', 'ask', 'user'),
        text('a1', 'Looking.'),
        text('s1', 'also', 'user'),
        text('a2', 'Done.')
      ],
      ['u1', 'u1', 'u1', 'u1']
    )
    expect(nativeChatRailReplyPreview(rows, [], 'u1')).toBe('Done.')
    expect(nativeChatRailReplyPreview(rows, [], 's1')).toBe('Done.')
    expect(nativeChatRailReplyPreview(rows, [], 'gone')).toBe('')
  })

  it('reads unloaded history its reply from the host', () => {
    const rows = rowsOf([text('u1', 'ask', 'user'), text('a1', 'Done.')], ['u1', 'u1'])
    const items = mergeNativeChatRailOutline(outline, [])
    expect(nativeChatRailReplyPreview(rows, items, 'old-1')).toBe('Host reply 1')
    expect(nativeChatRailReplyPreview(rows, items, 'old-2')).toBe('Host reply 2, cut off early')
  })

  // A long live turn scrolls its own prompt out of the loaded window; the host's
  // reply for it was cut when the outline was read, the loaded rows are current.
  it('prefers the loaded end of a turn whose prompt is no longer loaded', () => {
    const rows = rowsOf(
      [text('a0', 'Still going, latest words.'), text('u1', 'ask', 'user')],
      ['old-2', 'u1']
    )
    const items = mergeNativeChatRailOutline(outline, [])
    expect(nativeChatRailReplyPreview(rows, items, 'old-2')).toBe('Still going, latest words.')
    expect(nativeChatRailReplyPreview(rows, items, 'old-1')).toBe('Host reply 1')
  })

  // A steer is in the turn it was sent into, under another message's key: without
  // the host naming that turn it would keep the host's reply while its turn's own
  // prompt, beside it on the rail, showed the loaded one.
  it("reads an unloaded steer the loaded end of its turn, as its turn's prompt", () => {
    const rows = rowsOf([text('a0', 'Still going, latest words.')], ['old-2'])
    const items = mergeNativeChatRailOutline(
      [
        ...outline,
        { id: 'steer', text: 'also this', hasImages: false, reply: 'Stale.', turnKey: 'old-2' }
      ],
      []
    )
    expect(nativeChatRailReplyPreview(rows, items, 'steer')).toBe('Still going, latest words.')
    expect(nativeChatRailReplyPreview(rows, items, 'old-2')).toBe('Still going, latest words.')
  })
})

describe('rail tick sampling', () => {
  it('keeps every tick while the thread fits', () => {
    const items = railItems(NATIVE_CHAT_RAIL_ROOMY_TICKS)
    expect(selectNativeChatRailTicks({ items, keepIds: [] })).toBe(items)
  })

  // A tick is the only way to its message, so a tall transcript draws more of them.
  it('fits more ticks into a taller viewport, never fewer than the roomy count', () => {
    const items = railItems(60)
    expect(nativeChatRailTickCapacity(0)).toBe(NATIVE_CHAT_RAIL_ROOMY_TICKS)
    const maxTicks = nativeChatRailTickCapacity(800)
    expect(maxTicks).toBeGreaterThanOrEqual(60)
    expect(selectNativeChatRailTicks({ items, keepIds: [], maxTicks })).toBe(items)
    expect(selectNativeChatRailTicks({ items, keepIds: [], maxTicks: 30 })).toHaveLength(30)
  })

  it('caps a long thread and keeps both ends', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, keepIds: [] })
    expect(ticks).toHaveLength(NATIVE_CHAT_RAIL_ROOMY_TICKS)
    expect(ticks[0]?.id).toBe('m0')
    expect(ticks.at(-1)?.id).toBe('m119')
  })

  it('always includes the active tick', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, keepIds: ['m7'] })
    expect(ticks.map((tick) => tick.id)).toContain('m7')
    expect(ticks).toHaveLength(NATIVE_CHAT_RAIL_ROOMY_TICKS)
  })

  // Losing an end would make the rail claim the conversation starts or stops
  // somewhere it doesn't, so the eviction has to fall on a neighbour instead.
  it('evicts a neighbour rather than an end when the active tick is near one', () => {
    const items = railItems(120)
    const ticks = selectNativeChatRailTicks({ items, keepIds: ['m1'] })
    const ids = ticks.map((tick) => tick.id)
    expect(ids).toContain('m0')
    expect(ids).toContain('m1')
    expect(ids).toContain('m119')
  })

  // A previewed or focused tick must not be resampled away as the reader scrolls.
  it('keeps every named tick at once, within the cap', () => {
    const ticks = selectNativeChatRailTicks({ items: railItems(120), keepIds: ['m7', 'm8', null] })
    expect(ticks).toHaveLength(NATIVE_CHAT_RAIL_ROOMY_TICKS)
    expect(ticks.map((tick) => tick.id)).toEqual(expect.arrayContaining(['m0', 'm7', 'm8', 'm119']))
  })

  it('returns ticks in thread order', () => {
    const ticks = selectNativeChatRailTicks({ items: railItems(120), keepIds: ['m63'] })
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
