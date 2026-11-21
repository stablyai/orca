import { useRef } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupMessage, BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatTranscriptColumn } from '../native-chat/NativeChatTranscriptColumn'
import { BotGroupPeerRequestLine } from './BotGroupPeerRequestLine'
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

function replyTurn(id: string, botId: string, botName: string, text: string): Turn {
  const scope = { kind: 'turn', turnItemId: `turn-${id}` } as const
  return {
    operationId: id,
    botId,
    botName,
    avatar: null,
    agent: 'claude',
    sessionId: `bot-group-member-${botId}`,
    frozenItems: [
      {
        itemId: `turn-${id}`,
        revision: 2,
        sequence: 1,
        observedAt: at,
        turnScope: scope,
        body: {
          kind: 'turn',
          turnId: id,
          state: 'completed',
          startedAt: at,
          completedAt: at + 4_000
        }
      },
      {
        itemId: `reply-${id}`,
        revision: 1,
        sequence: 2,
        observedAt: at + 1_000,
        turnScope: scope,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
      }
    ]
  }
}

const handoff = (from: string, turn: Turn): BotGroupMessage => ({
  id: `line-${turn.operationId}`,
  groupId: 'group',
  sequence: 1,
  author: { kind: 'bot', id: from, name: from },
  text: '',
  createdAt: at,
  requester: { id: from, name: from },
  mentioned: true,
  turns: [turn]
})

const pausedRoom: BotGroupMessage[] = [
  handoff(
    'Triage',
    replyTurn(
      'a',
      'bot-2',
      'Reviewer',
      'Two nits left on the hunk header. @Triage can you fold them in?'
    )
  ),
  handoff('Reviewer', replyTurn('b', 'bot-1', 'Triage', 'Folded in. @Reviewer one last look?')),
  {
    id: 'paused',
    groupId: 'group',
    sequence: 2,
    author: { kind: 'bot', id: 'bot-2', name: 'Reviewer' },
    text: '',
    createdAt: at,
    pausedAfter: 6,
    turns: []
  }
]

function PausedRoom() {
  const rootRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={rootRef} data-native-chat-root className="p-4">
      <NativeChatTranscriptColumn className="space-y-6 py-6">
        {pausedRoom.map((message) => (
          <div key={message.id} className="space-y-5">
            <BotGroupPeerRequestLine message={message} />
            {message.turns.map((turn) => (
              <BotGroupTurn
                key={turn.operationId}
                hostId="local"
                turn={turn}
                files={null}
                roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef }}
                roomRows={new BotGroupTranscriptRows()}
                tabId="room-tab"
                isVisible
                onStop={() => {}}
                onReply={() => {}}
                scrollMessageToTop={() => {}}
              />
            ))}
          </div>
        ))}
      </NativeChatTranscriptColumn>
    </div>
  )
}

/** Members handing off by @Name until the post's limit holds the next one on a quiet line. */
export const handoffsPaused = defineFixture({ width: 640, render: () => <PausedRoom /> })
