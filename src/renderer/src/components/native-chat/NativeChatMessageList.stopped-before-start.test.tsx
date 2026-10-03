// @vitest-environment happy-dom

// A send a Stop took back before the agent started it stays where it was sent, with one row after
// it, never under the turn before, and with no header of its own.

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../../shared/structured-agent-session-dispatch-rejection'
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

const STOP_ROW = 'Stopped before the agent started'
const THREAD: AgentJournalTurnScope = { kind: 'thread' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const sent = (id: string, text: string) =>
  item(agentJournalSubmissionKey(id), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

function turn(
  itemId: string,
  userId: string,
  seconds: number,
  end: { state: 'completed' | 'interrupted'; outcome: 'success' | 'cancellation' }
) {
  return item(itemId, {
    kind: 'turn',
    turnId: itemId,
    ...end,
    userItemId: agentJournalSubmissionKey(userId),
    startedAt: 1_000,
    completedAt: 1_000 + seconds * 1_000
  })
}

/** "warm up", answered and settled in 3s. */
function warmUp(): AgentJournalRenderItem[] {
  return [
    sent('warm-up', 'warm up'),
    turn('t1', 'warm-up', 3, { state: 'completed', outcome: 'success' }),
    item(
      't1-answer',
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Warmed up.' }] },
      { kind: 'turn', turnItemId: 't1' }
    )
  ]
}

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...overrides
  }
}

const stopped = (id: string) =>
  submission(id, { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })

function journalList(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  live: { isWorking: boolean; workingStartedAt: number | null } = {
    isWorking: false,
    workingStartedAt: null
  }
): React.JSX.Element {
  return (
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
      isWorking={live.isWorking}
      workingStartedAt={live.workingStartedAt}
      expandSignal={false}
      fontScale={1}
    />
  )
}

function renderJournal(items: AgentJournalRenderItem[], submissions: AgentJournalSubmission[]) {
  render(journalList(items, submissions))
}

function follows(later: HTMLElement, earlier: HTMLElement): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('a send a Stop took back before the agent started it', () => {
  it('stays after the turn before it, with the stop row after it and no header of its own', () => {
    renderJournal(
      [...warmUp(), sent('never-ran', 'look around')],
      [submission('warm-up'), stopped('never-ran')]
    )

    const message = screen.getByText('look around')
    const row = screen.getByText(STOP_ROW)
    expect(follows(message, screen.getByText('Warmed up.'))).toBe(true)
    expect(follows(row, message)).toBe(true)
    expect(screen.getAllByText(/^(Worked|Working) for/)).toHaveLength(1)
    expect(screen.getByText('Worked for 3s')).toBeInTheDocument()
  })

  it('keeps no clock it showed while the send waited on its turn', () => {
    const items = [...warmUp(), sent('never-ran', 'look around')]
    const { rerender } = render(
      journalList(
        items,
        [submission('warm-up'), submission('never-ran', { dispatchState: 'pending' })],
        {
          isWorking: true,
          workingStartedAt: Date.now() - 5_000
        }
      )
    )
    expect(screen.getByText('Working for 5s')).toBeInTheDocument()

    rerender(journalList(items, [submission('warm-up'), stopped('never-ran')]))

    expect(screen.getAllByText(/^(Worked|Working) for/).map((node) => node.textContent)).toEqual([
      'Worked for 3s'
    ])
    expect(follows(screen.getByText(STOP_ROW), screen.getByText('look around'))).toBe(true)
  })

  it('draws one stop row after sends taken back together', () => {
    renderJournal(
      [...warmUp(), sent('first', 'first send'), sent('second', 'second send')],
      [submission('warm-up'), stopped('first'), stopped('second')]
    )

    expect(screen.getAllByText(STOP_ROW)).toHaveLength(1)
    expect(follows(screen.getByText(STOP_ROW), screen.getByText('second send'))).toBe(true)
  })

  it('leaves a send whose turn opened to that turn, which says it was interrupted', () => {
    renderJournal(
      [
        ...warmUp(),
        sent('opened', 'look around'),
        turn('t2', 'opened', 2, { state: 'interrupted', outcome: 'cancellation' })
      ],
      [submission('warm-up'), stopped('opened')]
    )

    expect(screen.getByText('look around')).toBeInTheDocument()
    expect(screen.getByText('Interrupted after 2s')).toBeInTheDocument()
    expect(screen.queryByText(STOP_ROW)).toBeNull()
  })
})
