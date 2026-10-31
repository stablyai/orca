import { nativeChatQueueFollowUps } from '../../../../shared/native-chat-follow-up-behavior'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from '../../../../shared/agent-session-journal-schemas'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import {
  structuredAgentSessionQueueRequest,
  structuredAgentSessionSendQueues,
  type StructuredAgentSessionQueueDelivery
} from './structured-agent-session-queue-request'

function queue(
  overrides: Partial<StructuredAgentSessionQueueDelivery> = {}
): StructuredAgentSessionQueueDelivery {
  return {
    capability: 'supported',
    followUpsQueue: false,
    isWorking: true,
    stopping: false,
    session: { queuedMessages: [] },
    prompts: [],
    ...overrides
  }
}

const WAITING_COMMAND: AgentSessionQueuedMessage = {
  messageId: 'compact',
  position: 1,
  state: 'waiting',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/compact' }],
    command: { name: 'compact' }
  }
}

// An approval of a kind this build cannot draw: no one here can answer it.
function unanswerablePrompt(): { body: AgentJournalItemBody } {
  const body = {
    kind: 'approval',
    title: 'Review',
    detail: null,
    subject: { kind: 'diff' },
    options: [{ id: 'allow', label: 'Approve' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  if (!isAdmissibleAgentJournalItemBody(body)) {
    throw new Error('Invalid pending prompt fixture')
  }
  return { body }
}

describe('per-send queue resolution', () => {
  it.each([
    undefined,
    null,
    {},
    { nativeChatQueueFollowUps: null },
    { nativeChatQueueFollowUps: 'false' },
    { nativeChatQueueFollowUps: true },
    { nativeChatQueueFollowUps: false }
  ])('normalizes one preference source into default and alternate requests (%j)', (settings) => {
    const followUpsQueue = nativeChatQueueFollowUps(settings)
    const enabled = settings?.nativeChatQueueFollowUps !== false
    expect(structuredAgentSessionQueueRequest(queue({ followUpsQueue }))).toBe(
      enabled ? 'queue-if-active' : undefined
    )
    expect(structuredAgentSessionQueueRequest(queue({ followUpsQueue }), true)).toBe(
      enabled ? undefined : 'queue-if-active'
    )
  })

  it.each([
    { followUpsQueue: true, alternate: false, queues: true },
    { followUpsQueue: true, alternate: true, queues: false },
    { followUpsQueue: false, alternate: false, queues: false },
    { followUpsQueue: false, alternate: true, queues: true }
  ])(
    'setting Queue=$followUpsQueue, alternate=$alternate queues=$queues while the agent works',
    ({ followUpsQueue, alternate, queues }) => {
      expect(structuredAgentSessionSendQueues(queue({ followUpsQueue }), alternate)).toBe(queues)
      expect(structuredAgentSessionQueueRequest(queue({ followUpsQueue }), alternate)).toBe(
        queues ? 'queue-if-active' : undefined
      )
    }
  )

  it('never queues on a host that does not advertise queueing, or before it answers', () => {
    for (const capability of ['unsupported', 'unknown'] as const) {
      expect(structuredAgentSessionSendQueues(queue({ capability, followUpsQueue: true }))).toBe(
        false
      )
      expect(structuredAgentSessionSendQueues(queue({ capability }), true)).toBe(false)
    }
  })

  it('the alternate applies only while the agent works and no Stop is ending its turn', () => {
    expect(structuredAgentSessionSendQueues(queue({ isWorking: false }), true)).toBe(false)
    expect(structuredAgentSessionSendQueues(queue({ stopping: true }), true)).toBe(false)
    expect(
      structuredAgentSessionSendQueues(queue({ followUpsQueue: true, stopping: true }), true)
    ).toBe(true)
  })

  it('a waiting command still queues every send, alternate or not', () => {
    const session = { queuedMessages: [WAITING_COMMAND] }
    expect(structuredAgentSessionSendQueues(queue({ session }))).toBe(true)
    expect(structuredAgentSessionSendQueues(queue({ followUpsQueue: true, session }), true)).toBe(
      true
    )
  })

  it('prompts no one here can answer send immediately, alternate or not', () => {
    const prompts = [unanswerablePrompt()]
    expect(structuredAgentSessionSendQueues(queue({ followUpsQueue: true, prompts }))).toBe(false)
    expect(structuredAgentSessionSendQueues(queue({ prompts }), true)).toBe(false)
  })
})
