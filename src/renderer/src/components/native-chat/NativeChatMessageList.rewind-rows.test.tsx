// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })
let sequence = 0
function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}
const say = (
  itemId: string,
  role: 'user' | 'assistant',
  text: string,
  scope: AgentJournalTurnScope = THREAD,
  extra: { command?: { name: string } } = {}
) => item(itemId, { kind: 'message', role, blocks: [{ type: 'text', text }], ...extra }, scope)
const settledTurn = (itemId: string, userItemId: string, start: number) =>
  item(itemId, {
    kind: 'turn',
    turnId: itemId,
    state: 'completed',
    outcome: 'success',
    userItemId,
    startedAt: start,
    completedAt: start + 1_000
  })

const REWIND = { disabledReason: null, request: vi.fn() }

describe('which transcript rows offer Rewind to here', () => {
  it('offers it only on prompts that opened their own turn', () => {
    const steer = agentJournalSubmissionKey('steer')
    const compact = agentJournalItemKey({ provider: 'orca', clientMessageId: 'cmd-1' })
    const items = [
      say('u1', 'user', 'List three fruits'),
      settledTurn('t1', 'u1', 1_000),
      say(steer, 'user', 'Make it four', inTurn('t1')),
      say('t1-answer', 'assistant', 'Apple, banana, cherry, date.', inTurn('t1')),
      say(compact, 'user', '/compact', THREAD, { command: { name: 'compact' } }),
      settledTurn('t2', compact, 5_000),
      say('u3', 'user', 'Now vegetables'),
      settledTurn('t3', 'u3', 9_000),
      say('t3-answer', 'assistant', 'Carrot.', inTurn('t3'))
    ]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'steer',
        fence: 1,
        payloadFingerprint: 'steer',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 2_000,
        resolvedAt: 2_100
      }
    ]
    render(
      <TooltipProvider>
        <NativeChatRewindContext.Provider value={REWIND}>
          <NativeChatMessageList
            session={{
              messages: projectStructuredAgentSessionMessages(items, [], submissions, {
                rejectedInPlace: true
              }),
              status: 'ready',
              sessionId: 'session-1',
              agent: 'codex',
              hasMore: false,
              loadingEarlier: false,
              olderHistoryGeneration: 0,
              loadEarlier: vi.fn(),
              readPhase: 'ready'
            }}
            journalItems={items}
            journalSubmissions={submissions}
            isWorking={false}
            expandSignal={false}
          />
        </NativeChatRewindContext.Provider>
      </TooltipProvider>
    )
    expect(screen.getByText('Make it four')).toBeInTheDocument()
    expect(screen.getByText('/compact')).toBeInTheDocument()
    const offered = screen.getAllByRole('button', { name: 'Rewind to here' })
    const after = (later: Element, earlier: Element) =>
      Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
    // The opener's and the last prompt's; the steer and the /compact row get none.
    expect(offered).toHaveLength(2)
    expect(after(offered[0]!, screen.getByText('List three fruits'))).toBe(true)
    expect(after(screen.getByText('Make it four'), offered[0]!)).toBe(true)
    expect(after(offered[1]!, screen.getByText('Now vegetables'))).toBe(true)
  })
})
