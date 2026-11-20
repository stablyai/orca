// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import {
  MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER,
  nativeChatBotItemNoteClusters
} from '../../bot-items/native-chat-bot-item-note-clusters'
import { NativeChatTranscriptRowStack } from './NativeChatTranscriptItems'
import { nativeChatRowDrawnAbove } from './use-native-chat-viewport-align'

afterEach(cleanup)

function noteSlot(id: string): NativeChatMessageSlot {
  const message: NativeChatMessage = {
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [],
    botItemNote: {
      noteId: id,
      by: 'owner',
      entries: [
        {
          uid: `item-${id}`,
          number: 1,
          title: `Item ${id}`,
          status: 'working',
          event: 'status',
          from: 'planned',
          to: 'working'
        }
      ]
    }
  }
  return {
    kind: 'message',
    message,
    turnKey: undefined,
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

const context: NativeChatTranscriptRowContext = {
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  onToggleExpandedTurn: () => {},
  onScrollMessageToTop: () => {},
  readerAtEnd: () => true,
  onRevealDiff: () => {}
}

const run = nativeChatBotItemNoteClusters(
  Array.from({ length: MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER + 2 }, (_, index) => noteSlot(`n${index}`))
)

/** Each drawn row of the stack, by the first note it holds. */
function rowsByFirstNote(container: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>()
  for (const row of container.firstElementChild!.children) {
    const note = row.querySelector<HTMLElement>('[data-native-chat-message-id]')
    if (row instanceof HTMLElement && note?.dataset.nativeChatMessageId) {
      rows.set(note.dataset.nativeChatMessageId, row)
    }
  }
  return rows
}

describe('a long run of notes outside the window (a group turn, rows after the live turn)', () => {
  it('draws each later slot 4 px below the one before, as the window does', () => {
    const { container } = render(
      <TooltipProvider>
        <NativeChatTranscriptRowStack slots={run} context={context} />
      </TooltipProvider>
    )
    const rows = rowsByFirstNote(container)

    expect(rows.get('n0')!.className).not.toContain('-mt-4')
    expect(rows.get(`n${MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER}`)!.className).toContain('-mt-4')
  })

  it('keeps the whole gap below an approval card drawn after the slot before', () => {
    const card = { key: 'approval', at: 1, node: <div>Approve?</div> }
    const { container } = render(
      <TooltipProvider>
        <NativeChatTranscriptRowStack
          slots={run}
          context={{ ...context, timedRows: new Map([['n0', [card]]]) }}
        />
      </TooltipProvider>
    )

    expect(
      rowsByFirstNote(container).get(`n${MAX_NATIVE_CHAT_ITEM_NOTE_CLUSTER}`)!.className
    ).not.toContain('-mt-4')
  })
})

describe('where a jump lands a row', () => {
  function row(wrapperTop: number, contentTop: number): HTMLElement {
    const wrapper = document.createElement('div')
    const content = document.createElement('div')
    wrapper.append(content)
    wrapper.getBoundingClientRect = () => new DOMRect(0, wrapperTop, 100, 40)
    content.getBoundingClientRect = () => new DOMRect(0, contentTop, 100, 56)
    return wrapper
  }

  it('lands a slot that pulls up into the gap by its first note, not by its own top', () => {
    expect(nativeChatRowDrawnAbove(row(200, 184))).toBe(16)
  })

  it('lands every other row by its own top', () => {
    expect(nativeChatRowDrawnAbove(row(200, 200))).toBe(0)
    expect(nativeChatRowDrawnAbove(document.createElement('div'))).toBe(0)
  })
})
