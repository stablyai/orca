import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { BotItemNoteEntry } from '../../../../../shared/bots/bot-item-note'
import type {
  NativeChatMessageSlot,
  NativeChatTranscriptSlot
} from '../conversation/slots/native-chat-transcript-slots'
import {
  MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER,
  nativeChatBotItemNoteClusters,
  nativeChatSlotJoinsNotesAbove
} from './native-chat-bot-item-note-clusters'

const entry: BotItemNoteEntry = {
  uid: 'a',
  number: 1,
  title: 'Share dialog',
  status: 'working',
  event: 'status',
  from: 'planned',
  to: 'working'
}

function slot(
  message: NativeChatMessage,
  overrides: Partial<NativeChatMessageSlot> = {}
): NativeChatMessageSlot {
  return {
    kind: 'message',
    message,
    turnKey: 't1',
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    estimatedHeight: 24,
    ...overrides
  }
}

function note(id: string, by: 'bot' | 'owner', entries: BotItemNoteEntry[] = [entry]) {
  return slot({
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [],
    botItemNote: { noteId: id, by, entries }
  })
}

/** Clustering yields only message slots here; anything else is a test failure, not a cast. */
function messageSlots(slots: readonly NativeChatTranscriptSlot[]): NativeChatMessageSlot[] {
  return slots.map((entry) => {
    if (entry.kind !== 'message') {
      throw new Error(`expected a message slot, got ${entry.kind}`)
    }
    return entry
  })
}

const prose = slot(
  {
    id: 'p',
    role: 'assistant',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Done.' }]
  },
  { estimatedHeight: 40 }
)

describe('item lines on the desktop', () => {
  it('draws consecutive item lines as one slot, 4 px apart at the chat’s spacing', () => {
    const clustered = nativeChatBotItemNoteClusters(
      [note('a', 'bot'), note('b', 'owner'), note('c', 'bot'), prose, note('d', 'bot')],
      { lineHeightPx: 20, charsPerLine: 80, spacingScale: 1.5 }
    )

    expect(
      clustered.map((entry) =>
        entry.kind === 'message'
          ? [entry.message.id, entry.itemNotes?.map((member) => member.id), entry.estimatedHeight]
          : null
      )
    ).toEqual([
      ['a', ['a', 'b', 'c'], 84],
      ['p', undefined, 40],
      // A lone note has the cluster's shape, so a note joining it later doesn't remount it.
      ['d', ['d'], 24]
    ])
  })

  it('ends a cluster at an owner’s comment and below a turn’s diff', () => {
    const comment: BotItemNoteEntry = { ...entry, event: 'commented', text: 'Ship it' }
    const diff = {
      ...note('b', 'bot'),
      turnDiff: { files: [], added: 0, removed: 0, truncated: false }
    }
    const clustered = nativeChatBotItemNoteClusters([
      note('a', 'bot'),
      diff,
      note('c', 'bot'),
      note('d', 'owner', [comment]),
      note('e', 'bot')
    ])

    expect(
      clustered.map((entry) =>
        entry.kind === 'message'
          ? (entry.itemNotes?.map((member) => member.id) ?? entry.message.id)
          : null
      )
    ).toEqual([['a', 'b'], ['c'], 'd', ['e']])
  })

  it('splits a long run into windowable slots that keep the notes 4 px apart', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER * 2 + 3 }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const clustered = nativeChatBotItemNoteClusters(run, {
      lineHeightPx: 20,
      charsPerLine: 80,
      spacingScale: 1.5
    })

    expect(
      clustered.map((entry) =>
        entry.kind === 'message'
          ? [entry.itemNotes?.length, entry.followsNotes, entry.estimatedHeight]
          : null
      )
    ).toEqual([
      // Eight notes and seven 6 px gaps.
      [8, undefined, 8 * 24 + 7 * 6],
      // Each later slot also pulls up into the row gap all but the notes' own gap (20 - 4, scaled).
      [8, true, 8 * 24 + 7 * 6 - 16 * 1.5],
      [3, true, 3 * 24 + 2 * 6 - 16 * 1.5]
    ])
  })

  it('leaves a full slot exactly as it was when the next note starts a new one', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const [before] = nativeChatBotItemNoteClusters(run)
    const [after, started] = nativeChatBotItemNoteClusters([...run, note('ninth', 'bot')])

    // The window may hold this slot's measurement long after it scrolls away; nothing about it moves.
    expect(after).toEqual(before)
    expect(started).toMatchObject({ itemNotes: [{ id: 'ninth' }], followsNotes: true })
  })

  it('keeps earlier slots of a run as they were when a note arrives', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 2 }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const before = nativeChatBotItemNoteClusters(run)
    const after = nativeChatBotItemNoteClusters([...run, note('late', 'bot')])

    expect(after.slice(0, -1)).toEqual(before.slice(0, -1))
    expect(after.at(-1)).toMatchObject({
      itemNotes: [...messageSlots(before).at(-1)!.itemNotes!, { id: 'late' }]
    })
  })

  it('starts a run afresh after anything that ends it', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 1 }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const clustered = nativeChatBotItemNoteClusters([...run, prose, note('after', 'bot')])

    expect(
      clustered.map((entry) => (entry.kind === 'message' ? entry.followsNotes === true : null))
    ).toEqual([false, true, false, false])
  })
})

describe('a slot that carries on a run of notes', () => {
  const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 1 }, (_, index) =>
    note(`n${index}`, 'bot')
  )
  const [first, second] = messageSlots(nativeChatBotItemNoteClusters(run))
  const joins = (overrides: Partial<Parameters<typeof nativeChatSlotJoinsNotesAbove>[0]> = {}) =>
    nativeChatSlotJoinsNotesAbove({
      slot: second!,
      previous: first,
      timedRowsAfter: undefined,
      markerKey: undefined,
      leavesWhole: false,
      ...overrides
    })

  it('joins a continued note slot even when another row has an approval card', () => {
    const card = { key: 'approval', at: 1, node: null }
    expect(joins({ timedRowsAfter: new Map([['elsewhere', [card]]]) })).toBe(true)
    expect(joins({ slot: first!, previous: prose })).toBe(false)
  })

  it('keeps the whole row gap where the "New" marker opens either row', () => {
    expect(joins({ markerKey: second!.message.id })).toBe(false)
    expect(joins({ markerKey: first!.message.id })).toBe(false)
  })

  it('keeps the whole row gap while it fades out whole', () => {
    expect(joins({ leavesWhole: true })).toBe(false)
  })
})
