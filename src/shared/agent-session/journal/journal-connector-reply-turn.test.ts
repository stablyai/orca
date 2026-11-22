import { describe, expect, it } from 'vitest'
import type { ConnectorMessageAsker } from '../../connector-message-asker'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { connectorReplyTurnOutcome, connectorReplyTurnStamps } from './journal-connector-reply-turn'

const success = (prose: string, bot = true) =>
  connectorReplyTurnOutcome({ outcome: 'success', prose, bot })

describe('a bot’s quiet marker on an answer to a request', () => {
  it('silences the whole reply, words before it included, wherever it was asked', () => {
    expect(success('Fixed both PRs.\n\nNO_REPLY')).toEqual({ outcome: 'quiet' })
    expect(success('  **NO_REPLY**  ')).toEqual({ outcome: 'quiet' })
  })

  it('never touches a marker that does not end the reply, or a non-bot’s words', () => {
    expect(success('Say NO_REPLY to skip.\nDone.')).toEqual({
      outcome: 'answered',
      prose: 'Say NO_REPLY to skip.\nDone.'
    })
    expect(success('Done. NO_REPLY', false)).toEqual({
      outcome: 'answered',
      prose: 'Done. NO_REPLY'
    })
  })
})

describe('the deliveries a turn answered', () => {
  const asker = (role: 'owner' | 'member'): ConnectorMessageAsker => ({
    source: 'slack',
    userId: role === 'owner' ? 'U0OWNER' : 'U0MEMBER',
    role,
    place: { kind: 'direct_message', id: 'D1' }
  })
  const message = (
    id: string,
    fields: Partial<Extract<AgentJournalRenderItem['body'], { kind: 'message' }>>
  ): AgentJournalRenderItem => ({
    itemId: agentJournalSubmissionKey(id),
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }], ...fields }
  })
  const dm = (deliveryId: string, role: 'owner' | 'member') =>
    message(deliveryId, {
      origin: 'connector',
      asker: asker(role),
      connectorDelivery: {
        account: 'a',
        conversation: { source: 'slack', externalId: `T1:D${role}:D${role}:U9` },
        deliveryId
      }
    })
  const steered = (id: string): AgentJournalSubmission => ({
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    answeredInTurn: { turnItemId: 'turn-1', via: 'steer' }
  })

  it('names each delivery the turn answered once, steered ones included', () => {
    const itemMail = message('mail', {})
    const stamps = connectorReplyTurnStamps(
      {
        items: [itemMail, dm('member-1', 'member'), dm('owner-1', 'owner')],
        submissions: [steered('member-1'), steered('owner-1')]
      },
      itemMail,
      'turn-1'
    )
    expect(stamps.map(({ deliveryId }) => deliveryId)).toEqual(['member-1', 'owner-1'])
  })

  it('names a delivery a claim and its own message both carry once, and never writes into the journal', () => {
    const asked = dm('owner-1', 'owner')
    const delivery = asked.body.kind === 'message' ? asked.body.connectorDelivery! : null
    const continued = message('continue', {
      connectorClaim: { cutTurnId: 'turn-0', cutKind: 'usage_limit', origin: [delivery!] }
    })
    const stamps = connectorReplyTurnStamps(
      { items: [asked, continued], submissions: [steered('owner-1')] },
      continued,
      'turn-1'
    )
    expect(stamps).toEqual([delivery])
    expect(stamps[0]).not.toBe(delivery)
  })
})
