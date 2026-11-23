import { useRef } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

const at = 1_800_000_000_000
const turnScope = { kind: 'turn', turnItemId: 'turn' } as const
const items: AgentJournalRenderItem[] = [
  {
    itemId: 'turn',
    revision: 2,
    sequence: 1,
    observedAt: at,
    turnScope,
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed',
      startedAt: at,
      completedAt: at + 9_000
    }
  },
  {
    itemId: 'start',
    revision: 1,
    sequence: 2,
    observedAt: at + 1_000,
    turnScope,
    body: {
      kind: 'agent-start',
      dispatchId: 'dispatch-1',
      task: 'Fix two diff-review issues in the review panel: the stale comment count and the collapsed hunk header.',
      worker: {
        party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
        name: 'Diff review fixer'
      }
    }
  },
  {
    itemId: 'reply',
    revision: 1,
    sequence: 3,
    observedAt: at + 2_000,
    turnScope,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: "I've taken the diff-review pair and started a worker on both. I'll report back when it lands."
        }
      ]
    }
  }
]

export const workerStartTurn: Turn = {
  operationId: 'operation-1',
  botId: 'bot-1',
  botName: 'Triage',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  frozenItems: items
}

function Room() {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-native-chat-root className="p-4">
      <NativeChatTranscriptColumn className="space-y-6 py-6">
        <BotGroupTurn
          hostId="local"
          turn={workerStartTurn}
          files={null}
          roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef }}
          roomRows={new BotGroupTranscriptRows()}
          tabId="room-tab"
          isVisible
          onStop={() => {}}
          onReply={() => {}}
          scrollMessageToTop={() => {}}
        />
      </NativeChatTranscriptColumn>
    </div>
  )
}

/** A member turn that started a worker, then replied: the card keeps its own row. */
export const workerCardThenReply = defineFixture({ width: 640, render: () => <Room /> })
