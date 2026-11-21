import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatMessageSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import { nativeChatBotItemNoteClusters } from '../../bot-items/native-chat-bot-item-note-clusters'
import { NativeChatTranscriptRowStack } from './NativeChatTranscriptItems'

const at = Date.parse('2026-11-14T15:14:00Z')

function noteSlot(index: number): NativeChatMessageSlot {
  const id = `note-${index}`
  const message: NativeChatMessage = {
    id,
    role: 'system',
    timestamp: at + index * 60_000,
    source: 'transcript',
    blocks: [],
    botItemNote: {
      noteId: id,
      by: 'owner',
      entries: [
        {
          uid: `item-${index}`,
          number: index + 1,
          title: `Item ${index + 1}`,
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

// Long enough to split into three slots, so two slot boundaries fall inside the run.
const run = nativeChatBotItemNoteClusters(Array.from({ length: 18 }, (_, index) => noteSlot(index)))

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

/** A long run of quiet item notes outside the window (a group turn, rows after the live turn). */
export const longNoteRun = defineFixture({
  width: 680,
  render: () => (
    <div className="bg-chat-pane p-4">
      <NativeChatTranscriptRowStack slots={run} context={context} />
    </div>
  )
})

/** The same run with an approval card drawn after the first slot's last note. */
export const longNoteRunWithCard = defineFixture({
  width: 680,
  render: () => (
    <div className="bg-chat-pane p-4">
      <NativeChatTranscriptRowStack
        slots={run}
        context={{
          ...context,
          timedRows: new Map([
            ['note-7', [{ key: 'approval', at, node: <div className="h-10">Approve?</div> }]]
          ])
        }}
      />
    </div>
  )
})
