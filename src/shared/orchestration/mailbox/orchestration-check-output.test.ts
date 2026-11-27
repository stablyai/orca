import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationCheckText,
  type OrchestrationMessageSummary
} from './orchestration-check-output'

describe('formatOrchestrationCheckText reply guidance', () => {
  const orcaItemMail: OrchestrationMessageSummary = {
    id: 'msg_item_reply_fixture',
    delivery_contract: 'current_delivery',
    type: 'status',
    from_handle: 'orca:items',
    to_handle: 'orca_session_id:11111111-1111-4111-8111-111111111111',
    subject: 'Item changed',
    body: 'An item changed.'
  }
  const botItemMail = {
    ...orcaItemMail,
    from_handle: 'orca_session_id:22222222-2222-4222-8222-222222222222'
  }
  const replyAction = /^\[Reply:\s+\S+\s+orchestration reply --id msg_item_reply_fixture\b/m
  const check = (message: OrchestrationMessageSummary) =>
    formatOrchestrationCheckText({ messages: [message], count: 1 }, message.to_handle ?? '')

  it('omits the raw check reply action for Orca item mail only', () => {
    expect(check(botItemMail)).toMatch(replyAction)
    expect(check(orcaItemMail)).not.toMatch(replyAction)
  })
})
