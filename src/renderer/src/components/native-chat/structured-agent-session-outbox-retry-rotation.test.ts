// @vitest-environment happy-dom

// A Retry on this client's own message the agent never got sends it again under a new id, at once,
// even while the agent works with queued follow-ups on. The new copy is the message: the old row is
// never drawn beside it, whatever becomes of the copy, and a reopen reads the same from the saved
// outbox. Drawn as the chat draws it: the transcript leaves out sends shown as queued cards.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryAttempt } from '../../../../shared/structured-agent-session-outbox-delivery'
import { disposeStructuredAgentSessionSendResult } from '../../../../shared/structured-agent-session-send-disposition'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { outboxOutsideQueuedCards } from './structured-agent-session-queued-cards'
import { retryStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-retry'
import {
  getStructuredAgentSessionOutbox,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

const SESSION = 'session-1'
// The agent is working and the host queues follow-ups, as the default setting has it.
const QUEUEING = { capability: 'supported', enabled: true } as const
const ORIGINAL = 'op-original'
const COPY = 'op-copy'

const ITEM: AgentJournalRenderItem = {
  itemId: agentJournalSubmissionKey(ORIGINAL),
  revision: 0,
  sequence: 5,
  observedAt: 5,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
}

const UNDELIVERED: AgentJournalSubmission = {
  clientMessageId: ORIGINAL,
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'rejected',
  providerItemId: null,
  submittedAt: 4,
  resolvedAt: 7,
  handoverRecorded: true,
  handedOverAt: 5,
  recovered: true,
  ...agentSessionFailureWords(agentSessionFailureFact('notDelivered'), { surface: 'rejection' })
}

function copyRow(patch: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    ...UNDELIVERED,
    clientMessageId: COPY,
    dispatchState: 'pending',
    reason: null,
    rejection: undefined,
    submittedAt: 9,
    resolvedAt: null,
    handedOverAt: undefined,
    recovered: undefined,
    ...patch
  }
}

/** What the chat draws: each row's id, and the ids that carry a notice. */
function drawn(
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: AgentJournalSubmission[]
) {
  return {
    rows: projectStructuredAgentSessionMessages(
      [ITEM],
      outboxOutsideQueuedCards(outbox, [], true, QUEUEING),
      submissions,
      { sentHere: outbox }
    ).map(({ id }) => id),
    noticed: [
      ...structuredAgentSessionDeliveryNotices(
        outbox,
        'Claude',
        vi.fn(),
        submissions,
        [],
        new Set()
      ).keys()
    ]
  }
}

describe("a Retry on this client's own message the agent never got", () => {
  let afterRetry: StructuredAgentSessionOutboxEntry[]

  beforeEach(() => {
    localStorage.clear()
    const own = reconcileStructuredAgentSessionOutbox(
      [
        {
          ...createStructuredAgentSessionOutboxEntry({
            clientMessageId: ORIGINAL,
            sessionId: SESSION,
            text: 'hello',
            attachments: [],
            queuedAt: 4
          }),
          state: 'dispatching',
          lastAttemptAt: 4
        }
      ],
      [UNDELIVERED]
    )
    writeOutbox(SESSION, own)
    retryStructuredAgentSessionOutboxEntry({
      clientMessageId: ORIGINAL,
      sessionId: SESSION,
      submissions: [UNDELIVERED],
      setError: vi.fn(),
      createOperationId: () => COPY
    })
    afterRetry = getStructuredAgentSessionOutbox(SESSION)
  })

  it('draws only the copy while it waits to go out, and after a reopen', () => {
    expect(afterRetry).toMatchObject([{ clientMessageId: COPY, rotatedFrom: [ORIGINAL] }])
    const copyKey = agentJournalSubmissionKey(COPY)
    expect(drawn(afterRetry, [UNDELIVERED])).toEqual({ rows: [copyKey], noticed: [] })
    // The saved outbox remembers the id it replaced.
    expect(drawn(readOutbox(SESSION), [UNDELIVERED])).toEqual({ rows: [copyKey], noticed: [] })
  })

  /** The drain's attempt at the copy while the agent works, and the host's answer to what it sent:
   *  a queued card for a send that asks to be queued, else the copy steered into the turn. */
  function sendWhileWorking(patch: Partial<AgentJournalSubmission>) {
    const { stored, wire } = structuredAgentSessionEntryAttempt(afterRetry[0]!, QUEUEING)
    const inFlight = [{ ...stored, state: 'dispatching' as const, lastAttemptAt: 9 }]
    const row = copyRow(patch)
    const { entries } = disposeStructuredAgentSessionSendResult({
      entries: inFlight,
      entry: inFlight[0]!,
      result: {
        ok: true,
        replayed: false,
        fence: 1,
        cursor: { epoch: 'epoch-1', sequence: 9 },
        value:
          wire.sentDelivery === 'queue-if-active'
            ? { clientMessageId: COPY, queued: { messageId: COPY, position: 1, state: 'waiting' } }
            : { clientMessageId: COPY, submission: row }
      },
      createOperationId: () => 'unused'
    })
    return { entries, submissions: [UNDELIVERED, row] }
  }

  it('sends the copy at once while the agent works, so it is never a card beside the old row', () => {
    expect(structuredAgentSessionEntryAttempt(afterRetry[0]!, QUEUEING).wire.sentDelivery).toBe(
      null
    )
    const { entries, submissions } = sendWhileWorking({})
    expect(drawn(entries, submissions)).toEqual({
      rows: [agentJournalSubmissionKey(COPY)],
      noticed: []
    })
  })

  it('never draws the old row beside the copy once the copy is handed over', () => {
    const { entries, submissions } = sendWhileWorking({ handedOverAt: 10 })
    expect(drawn(entries, submissions).noticed).toEqual([])
    expect(drawn(entries, submissions).rows).not.toContain(agentJournalSubmissionKey(ORIGINAL))
  })

  // The transcript leaves out a send it draws as a card; the whole outbox still names the row.
  it('hides the old row while the transcript leaves its copy out', () => {
    expect(
      projectStructuredAgentSessionMessages([ITEM], [], [UNDELIVERED], { sentHere: afterRetry })
    ).toEqual([])
  })

  it('never draws the old row beside a copy the host refused', () => {
    const refused = afterRetry.map((entry) => ({
      ...entry,
      lastAttemptAt: 9,
      lastFailure: { kind: 'refused' as const, code: 'agent_session_journal_unreadable' as const }
    }))
    expect(drawn(refused, [UNDELIVERED])).toEqual({
      rows: [agentJournalSubmissionKey(COPY)],
      noticed: [agentJournalSubmissionKey(COPY)]
    })
  })
})
