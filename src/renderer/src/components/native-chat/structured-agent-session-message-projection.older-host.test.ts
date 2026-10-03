// An older host leaves a rejected message where it was sent. When that is older than the loaded
// window, the chat holds its rejected submission but not its row: the outbox copy keeps drawing it,
// with no control, until the page holding the row loads, and then the host's row draws it instead.

import { expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { reconcileStructuredAgentSessionOutboxWithQueue } from '../../../../shared/structured-agent-session-draft-hand-off'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

const NO_CARDS: readonly string[] = []
const MESSAGE_ID = agentJournalSubmissionKey('m')

function answer(sequence: number): AgentJournalRenderItem {
  return {
    itemId: `a-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
  }
}

/** Where the older host left it: at its submission, far behind the loaded window. */
const SENT: AgentJournalRenderItem = {
  itemId: MESSAGE_ID,
  revision: 1,
  sequence: 10,
  observedAt: 10,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued msg' }] }
}

const REJECTED: AgentJournalSubmission = {
  clientMessageId: 'm',
  fence: 1,
  payloadFingerprint: 'x',
  dispatchState: 'rejected',
  providerItemId: null,
  reason: DISPATCH_REJECTED_HOST_RESTARTED,
  rejection: { kind: 'hostRestarted' },
  submittedAt: 10,
  resolvedAt: 2000
}

function page(
  items: AgentJournalRenderItem[],
  submissions: AgentJournalSubmission[],
  hasOlder: boolean
): AgentSessionHistoryPage {
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? 0
  return {
    sessionId: 's',
    epoch: 'e',
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions,
    window: {
      oldest: { epoch: 'e', sequence: oldest },
      newest: { epoch: 'e', sequence: newest },
      nextCursor: { epoch: 'e', sequence: oldest }
    },
    liveCursor: { epoch: 'e', sequence: 1099 },
    hasOlder,
    hasNewer: false
  }
}

it("keeps the outbox copy of a rejected message whose row is outside the window, then the host's row takes over", () => {
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'event',
    event: {
      type: 'snapshot',
      sessionId: 's',
      fence: 1,
      page: page(
        Array.from({ length: 100 }, (_, index) => answer(1000 + index)),
        [],
        true
      )
    }
  })
  // The rejection touches the row, which the older host left at its submission.
  state = reduceStructuredAgentSession(state, {
    type: 'event',
    event: {
      type: 'batch',
      sessionId: 's',
      batch: {
        cursor: { epoch: 'e', sequence: 1100 },
        items: [SENT],
        removedItemIds: [],
        submissions: [REJECTED]
      }
    }
  })
  expect(state.items.some((item) => item.itemId === MESSAGE_ID)).toBe(false)
  expect(state.submissions.map((submission) => submission.clientMessageId)).toEqual(['m'])

  const sent = {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: 'm',
      sessionId: 's',
      text: 'queued msg',
      attachments: [],
      queuedAt: 10
    }),
    state: 'dispatching' as const
  }
  const kept = reconcileStructuredAgentSessionOutboxWithQueue(
    [sent],
    state.submissions,
    state.items
  )
  expect(kept).toMatchObject([{ clientMessageId: 'm', state: 'rejected' }])
  const drawn = (outbox: typeof kept) =>
    projectStructuredAgentSessionMessages(state.items, outbox, state.submissions, NO_CARDS)
      .filter((message) => message.role === 'user')
      .map(({ id, unsent }) => ({ id, unsent }))
  expect(drawn(kept)).toEqual([{ id: MESSAGE_ID, unsent: true }])
  const notice = structuredAgentSessionDeliveryNotices(
    kept,
    'Claude',
    () => {},
    state.submissions,
    [],
    new Set()
  ).get(MESSAGE_ID)
  expect(notice).toEqual({ text: 'Orca restarted before this message was sent.' })

  // Paging back loads the row: the outbox lets go, and the host's row is the one drawn.
  state = reduceStructuredAgentSession(state, {
    type: 'older-page',
    requestedCursor: { epoch: 'e', sequence: 1000 },
    page: page(
      [SENT, ...Array.from({ length: 10 }, (_, index) => answer(990 + index))],
      [REJECTED],
      false
    )
  })
  expect(state.items.some((item) => item.itemId === MESSAGE_ID)).toBe(true)
  const released = reconcileStructuredAgentSessionOutboxWithQueue(
    kept,
    state.submissions,
    state.items
  )
  expect(released).toEqual([])
  expect(drawn(released)).toEqual([{ id: MESSAGE_ID, unsent: true }])
})
