import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationCheckText,
  type OrchestrationMessageSummary
} from './orchestration-check-output'
import {
  formatReportFollowUpCommand,
  type ReportFollowUpAction
} from './orchestration-report-follow-up'

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

  it('answers with a body file so no quoted text reaches the shell', () => {
    // A reporter follows this hint literally; `--body "..."` would run backticks in its report.
    expect(check(botItemMail)).toContain('--body-file <path>')
    expect(check(botItemMail)).not.toContain('--body "')
  })
})

describe('formatReportFollowUpCommand', () => {
  // Every one of these lines is copied by an agent, so each must pass its body as a file.
  const actions: ReportFollowUpAction[] = [
    { kind: 'send', dispatchId: 'dispatch_1', active: false },
    { kind: 'send', dispatchId: 'dispatch_1', active: true },
    { kind: 'worker_start' },
    { kind: 'worker_start_on', server: 'studio' },
    { kind: 'mail_sender', to: 'bot:reviewer' },
    { kind: 'mail_sender', to: 'bot:reviewer', chat: '123' }
  ]

  it('never writes the body inline for a command it prints', () => {
    for (const action of actions) {
      if (action.kind === 'information') {
        continue
      }
      const command = formatReportFollowUpCommand(action)
      expect(command).not.toContain('--body "')
    }
  })
})
