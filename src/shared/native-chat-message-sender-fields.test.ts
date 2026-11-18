import { describe, expect, it } from 'vitest'
import { nativeChatMessageSenderFields } from './native-chat-message-sender-fields'
import type { AutomationRunMessage } from './automations/automation-run-message'
import type { AgentJournalTypedBy } from './agent-session/journal/agent-journal-typed-by'

describe('native chat sender fields', () => {
  it('names another person only when the host found their account differs from its own', () => {
    const typed = (typedBy: AgentJournalTypedBy) =>
      nativeChatMessageSenderFields({ kind: 'message', role: 'user', blocks: [], typedBy }, 'user')
    const sam = {
      by: 'device',
      deviceId: 'd',
      account: 'Sam Lee',
      accountId: 'acct-sam'
    } as const
    expect(typed({ ...sam, own: false, computer: "Sam's MacBook Pro" })).toEqual({
      typedByOther: { name: 'Sam Lee', computer: "Sam's MacBook Pro" }
    })
    expect(typed({ ...sam, own: true })).toEqual({})
    expect(typed(sam)).toEqual({})
    expect(typed({ by: 'device', deviceId: 'd', own: false })).toEqual({})
  })

  it("marks an owner's setup-card answer as a notice, so no bubble is drawn", () => {
    expect(
      nativeChatMessageSenderFields(
        { kind: 'message', role: 'user', blocks: [], origin: 'card-answer' },
        'user'
      )
    ).toEqual({ orcaNotice: 'card-answer' })
    expect(
      nativeChatMessageSenderFields(
        { kind: 'message', role: 'assistant', blocks: [], origin: 'card-answer' },
        'assistant'
      )
    ).toEqual({})
  })

  it("reads an automation run only beside its origin, and a malformed one as the person's message", () => {
    const automationRun: AutomationRunMessage = {
      runId: 'run-1',
      automation: {
        id: 'auto-1',
        name: 'Morning digest',
        enabled: true,
        nextRunAt: 20,
        updatedAt: 1,
        dtstart: 1,
        rrule: 'FREQ=DAILY',
        workspaceId: null
      },
      trigger: 'scheduled',
      scheduledFor: 10,
      instructionsLength: 5
    }
    const run = (origin: 'automation-run' | undefined, value: AutomationRunMessage) =>
      nativeChatMessageSenderFields(
        {
          kind: 'message',
          role: 'user',
          blocks: [],
          ...(origin ? { origin } : {}),
          automationRun: value
        },
        'user'
      )

    expect(run('automation-run', automationRun)).toEqual({ automationRun })
    expect(run(undefined, automationRun)).toEqual({})
    expect(run('automation-run', { ...automationRun, instructionsLength: -1 })).toEqual({})
  })
})
