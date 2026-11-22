import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../native-chat-types'
import type { AutomationRunMessage } from '../../../automations/automation-run-message'
import type { BotAutomationFacts } from '../../../bots/bot-automation-rows'
import { EVENT_ONLY_SCHEDULE } from '../../../automation-event-triggers'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../notices/native-chat-pull-request-event'
import { nativeChatActivityRowJoins } from './native-chat-activity-rows'

let count = 0
const row = (
  role: NativeChatMessage['role'],
  fields: Partial<NativeChatMessage>
): NativeChatMessage => ({
  id: `row-${(count += 1)}`,
  role,
  source: 'transcript',
  timestamp: count,
  blocks: [],
  ...fields
})

const notice = (block: Partial<NativeChatTextBlock>): NativeChatMessage =>
  row('system', { blocks: [{ type: 'text', text: 'line', ...block }] })

const update = (): NativeChatMessage =>
  row('user', {
    blocks: [{ type: 'text', text: 'Pushed the fix.' }],
    from: {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Reviewer',
          relation: 'worker'
        }
      ],
      orchestration: { message: 'mail-notice', mailbox: 'term_b', dispatchId: null, messages: [] }
    }
  })

const automation: BotAutomationFacts = {
  id: 'a1',
  name: 'CI result',
  enabled: true,
  nextRunAt: 0,
  updatedAt: 0,
  ...EVENT_ONLY_SCHEDULE,
  workspaceId: null,
  once: {}
}
const run: AutomationRunMessage = {
  runId: 'r1',
  automation,
  trigger: 'scheduled',
  instructionsLength: 0
}

// Each row the chat draws as one line, which sits close to the one-line rows around it.
const oneLineRows: Record<string, () => NativeChatMessage> = {
  waiting: () =>
    row('system', {
      automationSaved: { change: 'created', automation }
    }),
  waitOver: () =>
    row('system', {
      waitEnded: { automation, ending: { kind: 'event', at: 1 } }
    }),
  automationRun: () =>
    row('user', {
      blocks: [{ type: 'text', text: 'Run the morning triage.' }],
      automationRun: run
    }),
  automationNotStarted: () =>
    row('system', {
      automationRunNotStarted: { run, actsFor: [], error: 'Send failed', text: '', at: 1 }
    }),
  automationResult: () =>
    notice({
      presentation: 'automation-result',
      automationResult: {
        automationId: 'a1',
        automationName: 'Triage',
        botName: 'Helper',
        runId: 'r1',
        trigger: 'schedule',
        outcome: 'finished',
        result: 'Nothing new.',
        at: 1
      }
    }),
  memoryUpdated: () =>
    notice({
      presentation: 'bot-memory-updated',
      botMemoryUpdated: {
        botId: 'b1',
        added: ['WSL is a paired remote server'],
        removed: [],
        topics: [],
        otherChanges: 0
      }
    }),
  handedTo: () =>
    notice({
      presentation: 'bot-request',
      botRequest: {
        toBotId: 'b2',
        toBotName: 'Builder',
        purpose: 'handoff',
        subject: 'Review',
        messageId: 'm1'
      }
    }),
  toolAdded: () =>
    row('system', {
      toolAdded: {
        botId: 'b1',
        tool: { name: 'Search', detail: 'https://search.example', remote: false },
        addedAt: 1
      }
    }),
  contextNote: () =>
    notice({ presentation: 'bot-context', botContext: { botId: 'b1', changed: ['soul'] } }),
  tidyUp: () => notice({ presentation: 'bot-tidy-up', tidyUp: { botId: 'b1', changes: 2 } }),
  pullRequestEvent: () => notice({ presentation: PULL_REQUEST_EVENT_PRESENTATION })
}

describe('one-line rows', () => {
  it.each(Object.entries(oneLineRows))('%s joins the one-line rows on both sides', (_, make) => {
    const joins = nativeChatActivityRowJoins([update(), make(), update()], () => false)
    expect([...joins.values()]).toEqual(['below', 'both', 'above'])
  })

  it('keeps the row gap around a boxed card and an agent reply', () => {
    const offer = notice({
      presentation: 'connector-offer',
      connectorOffer: { botId: 'b1', source: 'github' }
    })
    const reply = row('assistant', { blocks: [{ type: 'text', text: 'Done.' }] })
    expect(nativeChatActivityRowJoins([update(), offer, update()], () => false).size).toBe(0)
    expect(nativeChatActivityRowJoins([update(), reply, update()], () => false).size).toBe(0)
  })
})
