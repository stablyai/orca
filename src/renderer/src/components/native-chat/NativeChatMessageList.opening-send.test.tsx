// @vitest-environment happy-dom
// A message sent while the turn ahead is still opening waits at the tail, after that turn's live
// status, never as a bubble above it: the host holds it until the turn opens. The frames here are
// the ones a person sees during that wait, and through a Stop pressed during it.

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import {
  projectStructuredAgentSessionMessages,
  type StructuredAgentSessionOptimisticMessage
} from '../../../../shared/structured-agent-session-message-projection'
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
const NOW = 100_000

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope: THREAD }
}

const userMessage = (id: string, sequence: number, text: string) =>
  item(agentJournalSubmissionKey(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: NOW,
    resolvedAt: null,
    handoverRecorded: true,
    ...overrides
  }
}

/** A finished warm-up, then "first" handed over (row 5) with no turn record yet: its turn opens. */
function openingFirst(): {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
} {
  return {
    items: [
      userMessage('warm', 1, 'warm up'),
      item('turn-warm', 2, {
        kind: 'turn',
        turnId: 'turn-warm',
        state: 'completed',
        outcome: 'success',
        userItemId: agentJournalSubmissionKey('warm'),
        startedAt: 1_000,
        completedAt: 2_000
      }),
      userMessage('first', 5, 'first')
    ],
    submissions: [
      submission('warm', { dispatchState: 'accepted', resolvedAt: 2_000 }),
      submission('first', { acceptedSequence: 3, handedOverAt: NOW })
    ]
  }
}

/** The first send's turn record, written as its turn opens; Codex names its own provider key. */
const firstTurnOpened = (sequence: number) =>
  item('turn-first', sequence, {
    kind: 'turn',
    turnId: 'turn-first',
    state: 'running',
    userItemId: FIRST_TURN_PROVIDER_KEY,
    startedAt: NOW
  })
const FIRST_TURN_PROVIDER_KEY = 'codex:thread:turn-first:0'
const inFirstTurn: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'turn-first' }

/** This client's own send the host has not recorded yet: its lane still runs the first handover. */
const unrecorded = (
  clientMessageId: string,
  text: string
): StructuredAgentSessionOptimisticMessage => ({
  clientMessageId,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
  queuedAt: NOW + 100
})

function frame(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  optimistic: StructuredAgentSessionOptimisticMessage[],
  stopping = false
): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, optimistic, submissions, {
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
      settledTurns={selectStructuredAgentSettledTurns(items, submissions)}
      isWorking
      workingStartedAt={NOW}
      stopping={stopping}
      expandSignal={false}
    />
  )
}

function follows(later: HTMLElement, earlier: HTMLElement): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
}

/** The live turn's status, which carries the first send's working clock. */
const liveStatus = () => screen.getByText(/^Working for/)
/** The live turn's activity line, the last thing the live turn draws. */
const liveActivity = () => screen.getByText(/^(Working|Stopping)…$/)

/** `text` is drawn after the live turn: its status and its activity line. */
function waitsAtTheTail(text: string): void {
  expect(follows(screen.getByText(text), liveStatus())).toBe(true)
  expect(follows(screen.getByText(text), liveActivity())).toBe(true)
}

describe('a message sent while the turn ahead is still opening', () => {
  it('waits at the tail after the live status while the host has not recorded it yet', () => {
    const { items, submissions } = openingFirst()

    render(frame(items, submissions, [unrecorded('second', 'second')]))

    expect(follows(liveStatus(), screen.getByText('first'))).toBe(true)
    waitsAtTheTail('second')
  })

  // Accepted, and so placed at the row that accepted it, which is above the first send's handover.
  it('waits at the tail after the live status once the host holds it queued', () => {
    const { items, submissions } = openingFirst()

    render(
      frame(
        [...items, userMessage('second', 4, 'second')],
        [...submissions, submission('second', { acceptedSequence: 4 })],
        []
      )
    )

    expect(follows(liveStatus(), screen.getByText('first'))).toBe(true)
    waitsAtTheTail('second')
  })

  // A Stop takes back what is still queued: B stays after the live turn with its stop row, never
  // drawn above it. Settled now, it sits with the transcript, above the live line.
  it('stays after the live turn when a Stop takes it back, with no frame above the live status', () => {
    const { items, submissions } = openingFirst()
    const view = render(frame(items, submissions, [unrecorded('b', 'B')]))
    waitsAtTheTail('B')

    // Pressed: Stopping, with B now recorded and queued behind the first send.
    const queued = [...items, userMessage('b', 4, 'B')]
    view.rerender(
      frame(queued, [...submissions, submission('b', { acceptedSequence: 4 })], [], true)
    )
    waitsAtTheTail('B')

    // Withdrawn with the queue.
    const withdrawn = submission('b', {
      acceptedSequence: 4,
      dispatchState: 'rejected',
      resolvedAt: NOW + 200,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    view.rerender(frame(queued, [...submissions, withdrawn], [], true))
    const stopRow = screen.getByText('Stopped manually')
    expect(follows(screen.getByText('B'), liveStatus())).toBe(true)
    expect(follows(stopRow, screen.getByText('B'))).toBe(true)
    expect(follows(liveActivity(), stopRow)).toBe(true)
  })

  // The Q2 frame: Stop pressed while the host has not recorded B yet, its lane still busy.
  it('keeps an unrecorded B after the Stopping line, and a message typed while Stopping too', () => {
    const { items, submissions } = openingFirst()
    const view = render(frame(items, submissions, [unrecorded('b', 'B')], true))
    waitsAtTheTail('B')

    const typedWhileStopping: StructuredAgentSessionOptimisticMessage = {
      ...unrecorded('c', 'C'),
      queuedAt: NOW + 300,
      sentWhileStopping: true
    }
    view.rerender(frame(items, submissions, [unrecorded('b', 'B'), typedWhileStopping], true))
    waitsAtTheTail('B')
    waitsAtTheTail('C')
  })

  /** One frame per commit: "second" stays under the first send's live status and above its
   *  activity line, where it lands, and the live status stays on "first". */
  function walkTurnOpening(
    steps: [
      AgentJournalRenderItem[],
      AgentJournalSubmission[],
      StructuredAgentSessionOptimisticMessage[]
    ][]
  ): void {
    const view = render(<div />)
    for (const step of steps) {
      view.rerender(frame(...step))
      expect(follows(liveStatus(), screen.getByText('first'))).toBe(true)
      expect(follows(screen.getByText('second'), liveStatus())).toBe(true)
      expect(follows(liveActivity(), screen.getByText('second'))).toBe(true)
    }
  }

  function turnOpening() {
    const { items, submissions } = openingFirst()
    const [warm, first] = submissions
    if (!warm || !first) {
      throw new Error('expected the warm-up and the first send')
    }
    const opened = [...items, firstTurnOpened(6)]
    return {
      submissions,
      warm,
      first,
      opened,
      // Handed over as a steer once the turn opened (row 8).
      steered: [...opened, { ...userMessage('second', 8, 'second'), turnScope: inFirstTurn }],
      echoed: (sent: AgentJournalSubmission): AgentJournalSubmission => ({
        ...sent,
        dispatchState: 'accepted',
        providerItemId: FIRST_TURN_PROVIDER_KEY,
        resolvedAt: NOW + 20
      })
    }
  }

  it('draws it where it lands at every step of the turn opening, even with the steer echoed first', () => {
    const { submissions, warm, first, opened, steered, echoed } = turnOpening()
    const handedOver = submission('second', { acceptedSequence: 7, handedOverAt: NOW + 10 })
    walkTurnOpening([
      // The turn record is in; the host has not recorded "second" yet.
      [opened, submissions, [unrecorded('second', 'second')]],
      // Recorded after the turn record, not yet handed over.
      [
        [...opened, userMessage('second', 7, 'second')],
        [...submissions, submission('second', { acceptedSequence: 7 })],
        []
      ],
      [steered, [...submissions, handedOver], []],
      // Codex echoes the steer before the send that opened the turn, then that send.
      [steered, [warm, first, echoed(handedOver)], []],
      [steered, [warm, echoed(first), echoed(handedOver)], []]
    ])
  })

  // Two messages queued behind /compact, or sent while Stopping: "second" is accepted above the
  // first send's handover, and the first send's turn record lands before "second" is handed over.
  it('draws it where it lands at every step when it was accepted above the first send', () => {
    const { submissions, warm, first, opened, steered, echoed } = turnOpening()
    const [warmUp, warmTurn, firstRow, turnRecord] = opened
    if (!warmUp || !warmTurn || !firstRow || !turnRecord) {
      throw new Error('expected the warm-up, the first send and its turn record')
    }
    const queuedAbove = [warmUp, warmTurn, userMessage('second', 4, 'second'), firstRow, turnRecord]
    const queued = submission('second', { acceptedSequence: 4 })
    const handedOver = { ...queued, handedOverAt: NOW + 10 }
    walkTurnOpening([
      [queuedAbove, [...submissions, queued], []],
      // The first send echoes while "second" is still queued.
      [queuedAbove, [warm, echoed(first), queued], []],
      [steered, [...submissions, handedOver], []],
      [steered, [warm, first, echoed(handedOver)], []],
      [steered, [warm, echoed(first), echoed(handedOver)], []]
    ])
  })
})
