// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { openNativeChatSubagent } from '../native-chat/subagents/native-chat-open-subagent'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

const turnScope = { kind: 'turn', turnItemId: 'turn' } as const
const say = (itemId: string, sequence: number, text: string, agentId?: string) =>
  ({
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    turnScope,
    ...(agentId ? { agentId, producerKind: 'agent' as const } : {}),
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }) satisfies AgentJournalRenderItem

const turn: Turn = {
  operationId: 'room-op',
  botId: 'bot-1',
  botName: 'Triage',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  frozenItems: [
    {
      itemId: 'turn',
      revision: 2,
      sequence: 1,
      observedAt: 1,
      turnScope,
      body: { kind: 'turn', turnId: 't-1', state: 'completed', startedAt: 1, completedAt: 9 }
    },
    say('main', 2, 'Main agent reply'),
    say('child', 3, 'Subagent step text', 'task-1')
  ]
}

afterEach(() => {
  act(() => openNativeChatSubagent(`bot-group-turn:${turn.operationId}`, null))
  cleanup()
})

it("opens a member's subagent in the room turn and Esc returns to the turn", () => {
  const view = render(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={turn}
        files={null}
        roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef: createRef() }}
        roomRows={new BotGroupTranscriptRows()}
        tabId="room-tab"
        isVisible
        onStop={() => {}}
        onReply={() => {}}
        scrollMessageToTop={() => {}}
      />
    </TooltipProvider>
  )
  expect(view.queryByText('Subagent step text')).toBeNull()

  const open = view.getByRole('button', { name: 'Open Subagent' })
  fireEvent.click(open)
  expect(view.getByText('Subagent step text')).toBeTruthy()
  expect(view.queryByText('Main agent reply')).toBeNull()
  expect(view.getByRole('navigation', { name: 'Subagent path' })).toBeTruthy()

  fireEvent.keyDown(view.getByRole('navigation', { name: 'Subagent path' }), { key: 'Escape' })
  expect(view.getByText('Main agent reply')).toBeTruthy()
  expect(view.queryByText('Subagent step text')).toBeNull()
})
