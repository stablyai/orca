import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { BotItemNoteEntry } from '../../../../../shared/bots/bot-item-note'
import type { NativeChatMessageSlot } from '../conversation/slots/native-chat-transcript-slots'
import {
  MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER,
  nativeChatBotItemNoteClusters
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
          ? [entry.itemNotes?.length, entry.continuesNotes, entry.estimatedHeight]
          : null
      )
    ).toEqual([
      // Eight notes and seven 6 px gaps, less the row gap the next slot closes (20 - 4, scaled).
      [8, true, 8 * 24 + 7 * 6 - 16 * 1.5],
      [8, true, 8 * 24 + 7 * 6 - 16 * 1.5],
      [3, undefined, 3 * 24 + 2 * 6]
    ])
  })

  it('keeps earlier slots of a run as they were when a note arrives', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 2 }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const keys = (slots: ReturnType<typeof nativeChatBotItemNoteClusters>) =>
      slots.map((entry) =>
        entry.kind === 'message' ? entry.itemNotes?.map((member) => member.id) : null
      )
    const before = keys(nativeChatBotItemNoteClusters(run))
    const after = keys(nativeChatBotItemNoteClusters([...run, note('late', 'bot')]))

    expect(after.slice(0, -1)).toEqual(before.slice(0, -1))
    expect(after.at(-1)).toEqual([...before.at(-1)!, 'late'])
  })

  it('draws a slot of a run as a whole row gap only after the run’s last slot', () => {
    const run = Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 1 }, (_, index) =>
      note(`n${index}`, 'bot')
    )
    const clustered = nativeChatBotItemNoteClusters([...run, prose, note('after', 'bot')])

    expect(
      clustered.map((entry) => (entry.kind === 'message' ? entry.continuesNotes === true : null))
    ).toEqual([true, false, false, false])
  })
})
