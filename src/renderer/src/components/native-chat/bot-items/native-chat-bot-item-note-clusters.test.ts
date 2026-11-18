import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { BotItemNoteEntry } from '../../../../../shared/bots/bot-item-note'
import type { NativeChatMessageSlot } from '../conversation/slots/native-chat-transcript-slots'
import { nativeChatBotItemNoteClusters } from './native-chat-bot-item-note-clusters'

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
})
