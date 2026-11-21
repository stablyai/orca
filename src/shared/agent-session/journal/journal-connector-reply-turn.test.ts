import { describe, expect, it } from 'vitest'
import type { ConnectorMessageAsker } from '../../connector-message-asker'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  connectorReplyTurnOutcome,
  connectorReplyTurnStamps,
  connectorReplyWords
} from './journal-connector-reply-turn'

const success = (prose: string, addressed: boolean, bot = true) =>
  connectorReplyTurnOutcome({ outcome: 'success', prose, bot, addressed })

describe('a bot’s quiet marker on an answer to a request', () => {
  it('cannot silence the words a bot wrote to someone who addressed it, and only the marker goes', () => {
    expect(success('Fixed both PRs.\n\nNO_REPLY', true)).toEqual({
      outcome: 'answered',
      prose: 'Fixed both PRs.'
    })
    expect(success('Fixed both PRs. **NO_REPLY.**', true)).toEqual({
      outcome: 'answered',
      prose: 'Fixed both PRs.'
    })
  })

  it('still silences a reply that is only the marker', () => {
    expect(success('NO_REPLY', true)).toEqual({ outcome: 'quiet' })
    expect(success('  **NO_REPLY**  ', true)).toEqual({ outcome: 'quiet' })
  })

  it('keeps today’s silence where no one addressed the bot (a thread it follows, mail)', () => {
    expect(success('Nothing for me here.\n\nNO_REPLY', false)).toEqual({ outcome: 'quiet' })
    expect(
      connectorReplyTurnOutcome({ outcome: 'success', prose: 'Done. NO_REPLY', bot: true })
    ).toEqual({ outcome: 'quiet' })
  })

  it('never touches a marker that does not end the reply, or a non-bot’s words', () => {
    expect(success('Say NO_REPLY to skip.\nDone.', true)).toEqual({
      outcome: 'answered',
      prose: 'Say NO_REPLY to skip.\nDone.'
    })
    expect(success('Done. NO_REPLY', false, false)).toEqual({
      outcome: 'answered',
      prose: 'Done. NO_REPLY'
    })
    expect(connectorReplyWords('Done. NO_REPLY', { bot: false, addressed: false })).toBe(
      'Done. NO_REPLY'
    )
  })
})

describe('what a bot’s quiet answer says to its owner in their DM', () => {
  const words = (prose: string) => connectorReplyWords(prose, { bot: true, addressed: true })

  it('keeps a quoted mention of the marker that ends a sentence', () => {
    expect(words('Use `NO_REPLY`')).toBe('Use `NO_REPLY`')
    expect(words('Reply with `NO_REPLY.`')).toBe('Reply with `NO_REPLY.`')
    // On a line of its own, quoted or not, it is the marker.
    expect(words('Done.\n\n`NO_REPLY`')).toBe('Done.')
  })

  it('takes every trailing marker, and reads dressing alone as only the marker', () => {
    expect(words('Answer NO_REPLY NO_REPLY')).toBe('Answer')
    expect(words('NO_REPLY NO_REPLY')).toBeNull()
    for (const dressed of ['> NO_REPLY', '- NO_REPLY', '# NO_REPLY', '**NO_REPLY.**']) {
      expect(words(dressed)).toBeNull()
    }
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

  it('marks only those the bot’s owner sent, so a member’s DM steered into item mail stays private', () => {
    const itemMail = message('mail', {})
    const stamps = connectorReplyTurnStamps(
      {
        items: [itemMail, dm('member-1', 'member'), dm('owner-1', 'owner')],
        submissions: [steered('member-1'), steered('owner-1')]
      },
      itemMail,
      'turn-1'
    )
    expect(stamps.map(({ deliveryId, ownerAsked }) => [deliveryId, ownerAsked ?? false])).toEqual([
      ['member-1', false],
      ['owner-1', true]
    ])
  })

  it('keeps the owner’s mark on a delivery a claim names too, and never writes into the journal', () => {
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
    expect(stamps).toEqual([expect.objectContaining({ deliveryId: 'owner-1', ownerAsked: true })])
    expect(delivery).not.toHaveProperty('ownerAsked')
  })

  it('never marks a delivery the owner’s when only a member’s message carried it', () => {
    const asked = dm('member-1', 'member')
    const delivery = asked.body.kind === 'message' ? asked.body.connectorDelivery! : null
    const continued = message('continue', {
      connectorClaim: { cutTurnId: 'turn-0', cutKind: 'usage_limit', origin: [delivery!] }
    })
    const stamps = connectorReplyTurnStamps(
      { items: [asked, continued], submissions: [steered('member-1')] },
      continued,
      'turn-1'
    )
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).not.toHaveProperty('ownerAsked')
  })
})
