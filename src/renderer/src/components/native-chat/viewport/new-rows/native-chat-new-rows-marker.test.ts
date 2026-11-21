import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import { nativeChatSlotJournalPosition } from './native-chat-new-rows-marker'

function note(id: string, sequence: number, folded?: number): NativeChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [],
    journalPosition: { sequence, index: 0 },
    botItemNote: {
      noteId: id,
      by: 'bot',
      entries: [],
      ...(folded === undefined ? {} : { position: { sequence: folded, index: 0 } })
    }
  }
}

function slot(itemNotes: NativeChatMessage[]): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: itemNotes[0]!,
    itemNotes,
    turnKey: 't1',
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    estimatedHeight: 24
  }
}

describe('how new an item-note row is', () => {
  it('is as new as the newest note in it, including notes folded into an older first note', () => {
    expect(nativeChatSlotJournalPosition(slot([note('a', 2, 7)]))).toEqual({
      sequence: 7,
      index: 0
    })
    expect(nativeChatSlotJournalPosition(slot([note('a', 2, 7), note('b', 5)]))).toEqual({
      sequence: 7,
      index: 0
    })
    expect(nativeChatSlotJournalPosition(slot([note('a', 2), note('b', 5)]))).toEqual({
      sequence: 5,
      index: 0
    })
  })
})
