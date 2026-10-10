import { describe, expect, it } from 'vitest'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const SENDING = 'Sending…'

function body(text: string): StructuredAgentSessionPendingSend['body'] {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function pending(
  clientMessageId: string,
  phase: StructuredAgentSessionPendingSend['phase']
): StructuredAgentSessionPendingSend {
  return {
    clientMessageId,
    sessionId: 'session-1',
    body: body(clientMessageId),
    previewUris: [],
    queuedAt: 1,
    phase,
    issued: true
  }
}

function row(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  patch: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 1,
    ...patch
  }
}

function notices(args: {
  pending?: StructuredAgentSessionPendingSend[]
  submissions?: AgentJournalSubmission[]
  startFailures?: AgentSessionFailureFact[]
}) {
  return structuredAgentSessionDeliveryNotices({
    pending: args.pending ?? [],
    submissions: args.submissions ?? [],
    agentName: 'Claude',
    startFailures: args.startFailures ?? []
  })
}

function texts(map: ReturnType<typeof notices>): Record<string, string> {
  return Object.fromEntries(
    [...map].map(([id, notice]) => [id, notice.sending ? SENDING : notice.text])
  )
}

describe('the line under each of the chat own messages', () => {
  it('says only that a message on its way is sending', () => {
    expect(texts(notices({ pending: [pending('a', 'sending')] }))).toEqual({
      [agentJournalSubmissionKey('a')]: SENDING
    })
    // The host's row draws a recorded one.
    expect(texts(notices({ pending: [pending('c', 'recorded')] }))).toEqual({})
  })

  it("says nothing on a message the host recorded but couldn't confirm, as the common pattern", () => {
    expect(
      texts(
        notices({
          submissions: [row('a', 'unknown', { recovered: true }), row('b', 'accepted')]
        })
      )
    ).toEqual({})
  })

  it("words a message the host rejected from the host's fact, with no control", () => {
    const map = notices({
      submissions: [row('a', 'rejected', { reason: 'Claude does not support the image type .bmp' })]
    })
    const notice = map.get(agentJournalSubmissionKey('a'))
    expect(notice?.text).toBe('Claude does not support the image type .bmp')
    expect(notice?.onDismiss).toBeUndefined()
  })

  it('says nothing for a message a Stop withdrew: it went back to the composer', () => {
    expect(
      texts(notices({ submissions: [row('a', 'rejected', { rejection: { kind: 'cancelled' } })] }))
    ).toEqual({})
  })

  describe('a message rejected by a start whose row already says why', () => {
    const startFailed: AgentSessionFailureFact = {
      kind: 'startFailed',
      refusal: { code: 'agent_session_identity_required', details: { reason: 'recordMissing' } }
    }
    const statusRow = (itemId: string, fact: AgentSessionFailureFact): AgentJournalRenderItem => ({
      itemId,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(fact, { agentName: 'Claude', surface: 'row' })
      }
    })
    const startRowKey = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('gen'))

    it('reads only the start-failure rows', () => {
      expect(
        structuredAgentSessionStartFailureFacts([
          statusRow(startRowKey, startFailed),
          statusRow(agentJournalSubmissionKey('exit-row'), { kind: 'providerExited' })
        ])
      ).toEqual([startFailed])
    })

    it('says only that it was not sent, and words a rejection no row states in full', () => {
      const facts = structuredAgentSessionStartFailureFacts([statusRow(startRowKey, startFailed)])
      const recorded = (id: string) =>
        row(id, 'rejected', { reason: 'Written by the host.', rejection: startFailed })
      expect(texts(notices({ submissions: [recorded('first')], startFailures: facts }))).toEqual({
        [agentJournalSubmissionKey('first')]: 'Your message was not sent.'
      })
      expect(texts(notices({ submissions: [recorded('first')] }))).toEqual({
        [agentJournalSubmissionKey('first')]: "Claude couldn't start. Start a new chat to continue."
      })
    })
  })
})
