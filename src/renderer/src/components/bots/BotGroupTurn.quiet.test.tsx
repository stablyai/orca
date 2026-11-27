// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

afterEach(cleanup)

function row(itemId: string, sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    body,
    sequence,
    observedAt: 1_000 + sequence,
    turnScope: { kind: 'turn', turnItemId: 'turn-1' }
  }
}

/** A member's turn in a group room: the mail that opened it, then the member's final words. */
function renderMemberTurn(state: 'running' | 'completed', words: string): HTMLElement {
  const turn: Turn = {
    operationId: 'mail-op',
    botId: 'bot-1',
    botName: 'Triage',
    avatar: null,
    agent: 'claude',
    sessionId: 'bot-group-member-1',
    mailbox: true,
    frozenItems: [
      row('turn-1', 0, {
        kind: 'turn',
        turnId: 'provider-turn',
        state,
        userItemId: 'mail',
        startedAt: 1_000,
        outcome: state === 'completed' ? 'success' : undefined,
        completedAt: state === 'completed' ? 3_000 : undefined
      }),
      row('mail', 1, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Item ITEM-1 changed.' }]
      }),
      row('answer', 2, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: words }]
      })
    ]
  }
  return render(
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
  ).container
}

it("draws a member's quiet result as its bot chat does, never its marker", () => {
  const note = renderMemberTurn('completed', 'Moved ITEM-1 to done.\n\nNO_REPLY')
  expect(note.textContent).toContain('Moved ITEM-1 to done.')
  expect(note.textContent).not.toContain('NO_REPLY')
  cleanup()
  expect(renderMemberTurn('running', 'NO_REPLY').textContent).not.toContain('NO_REPLY')
  cleanup()
  expect(renderMemberTurn('completed', 'NO_REPLY').textContent).not.toContain('NO_REPLY')
  cleanup()
  expect(renderMemberTurn('completed', 'Done, see ITEM-1.').textContent).toContain(
    'Done, see ITEM-1.'
  )
})
