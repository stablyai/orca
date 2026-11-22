import { describe, expect, it } from 'vitest'
import type { NativeChatMessage, NativeChatTextBlock } from '../../native-chat-types'
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

type Message = NativeChatMessage
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

const automation = { id: 'a1', name: 'CI result', enabled: true, once: {} }

// Each row the chat draws as one line, which sits close to the one-line rows around it.
const oneLineRows: Record<string, () => NativeChatMessage> = {
  waiting: () =>
    row('system', {
      automationSaved: { change: 'created', automation } as Message['automationSaved']
    }),
  waitOver: () =>
    row('system', {
      waitEnded: { automation, ending: { kind: 'event', at: 1 } } as Message['waitEnded']
    }),
  automationRun: () =>
    row('user', {
      blocks: [{ type: 'text', text: 'Run the morning triage.' }],
      automationRun: { runId: 'r1', automation, trigger: 'scheduled' } as Message['automationRun']
    }),
  automationNotStarted: () =>
    row('system', {
      automationRunNotStarted: {
        run: { runId: 'r2', automation }
      } as Message['automationRunNotStarted']
    }),
  automationResult: () =>
    notice({
      presentation: 'automation-result',
      automationResult: { automationId: 'a1' } as NativeChatTextBlock['automationResult']
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
      toolAdded: { botId: 'b1', addedAt: 1 } as Message['toolAdded']
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
