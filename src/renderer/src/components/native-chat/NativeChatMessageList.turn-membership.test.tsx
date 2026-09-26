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
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

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
  scope: AgentJournalTurnScope = THREAD
) => item(itemId, { kind: 'message', role, blocks: [{ type: 'text', text }] }, scope)
const work = (itemId: string, scope: AgentJournalTurnScope) =>
  item(
    itemId,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }]
    },
    scope
  )
const settledTurn = (itemId: string, userItemId: string, seconds: number, start: number) =>
  item(itemId, {
    kind: 'turn',
    turnId: itemId,
    state: 'completed',
    outcome: 'success',
    userItemId,
    startedAt: start,
    completedAt: start + seconds * 1000
  })

/** "List three fruits", answered and settled in 4s. */
function fruitTurn(): AgentJournalRenderItem[] {
  return [
    say('u1', 'user', 'List three fruits'),
    settledTurn('t1', 'u1', 4, 1_000),
    say('t1-narration', 'assistant', 'Thinking about fruit.', inTurn('t1')),
    work('t1-work', inTurn('t1')),
    say('t1-answer', 'assistant', 'Apple, banana, cherry.', inTurn('t1'))
  ]
}

function renderJournal(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[] = []
): void {
  render(
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, [], submissions),
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
      settledTurns={selectStructuredAgentSettledTurns(items, submissions)}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function follows(later: HTMLElement, earlier: HTMLElement): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('NativeChatMessageList turns from the turn record', () => {
  it('gives /compact its own turn and result, and leaves the turn before it untouched', () => {
    const compactEntry = agentJournalSubmissionKey('cmd-1')
    const commandTurn = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'command-turn:cmd-1'
    })
    const items = [
      ...fruitTurn(),
      item(compactEntry, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      settledTurn(commandTurn, compactEntry, 2, 10_000),
      item(
        'command-result',
        { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' },
        inTurn(commandTurn)
      )
    ]
    renderJournal(items, [
      {
        clientMessageId: 'cmd-1',
        fence: 1,
        payloadFingerprint: 'f',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 9_000,
        resolvedAt: 12_000
      }
    ])

    expect(screen.getByText('Apple, banana, cherry.')).toBeInTheDocument()
    expect(screen.queryByText('Thinking about fruit.')).toBeNull()
    const compact = screen.getByText('/compact')
    const previousStatus = screen.getByText('Worked for 4s')
    const ownStatus = screen.getByText('Worked for 2s')
    expect(follows(compact, previousStatus)).toBe(true)
    expect(follows(ownStatus, compact)).toBe(true)
    expect(screen.getByRole('separator', { name: 'Context compacted' })).toBeInTheDocument()
  })

  it('keeps the row that says why a turn stopped visible in its folded turn', () => {
    const items = [
      ...fruitTurn(),
      item(
        'exit',
        { kind: 'status', text: 'The agent exited unexpectedly.', tone: 'error' },
        inTurn('t1')
      )
    ]
    renderJournal(items)

    expect(screen.queryByText('Thinking about fruit.')).toBeNull()
    expect(screen.getByText('The agent exited unexpectedly.')).toBeInTheDocument()
  })

  it('folds a turn the provider resumed on its own under its own status', () => {
    const wake = agentJournalItemKey({
      provider: 'legacy',
      agent: 'claude',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:wake'
    })
    const items = [
      ...fruitTurn(),
      // Claude keys a resumed turn's record on itself: no message opened it.
      settledTurn(wake, wake, 9, 20_000),
      say('wake-narration', 'assistant', 'The background build finished.', inTurn(wake)),
      work('wake-work', inTurn(wake)),
      say('wake-answer', 'assistant', 'All tests pass now.', inTurn(wake))
    ]
    renderJournal(items)

    const previousStatus = screen.getByText('Worked for 4s')
    const ownStatus = screen.getByText('Worked for 9s')
    expect(follows(ownStatus, screen.getByText('Apple, banana, cherry.'))).toBe(true)
    expect(follows(ownStatus, previousStatus)).toBe(true)
    expect(screen.queryByText('The background build finished.')).toBeNull()
    expect(screen.getByText('All tests pass now.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Toggle turn details' })).toHaveLength(2)
  })
})
