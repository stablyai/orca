// Adding a manifest entry exercises both skew directions and requires declaring the older peer’s behavior.

import { attachFingerprintFields } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import type { AgentSessionAttachParams } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import { computeAgentSessionPayloadFingerprint } from '../../../src/shared/agent-session-mutation-envelope'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../src/shared/structured-agent-session-send-mutation'

import {
  SESSION,
  WORKSPACE,
  THREAD,
  NOW,
  ATTENTION_READ,
  REWIND_METHOD,
  ITEM_DETAIL_METHOD
} from './structured-agent-session-surface-calls'

export {
  SESSION,
  WORKSPACE,
  THREAD,
  NOW,
  ATTENTION_READ,
  REWIND_METHOD,
  CONVERSATION_OUTLINE_METHOD,
  ITEM_DETAIL_METHOD,
  STATUS_FEED_METHOD,
  TURN_COMPLETION_FEED_METHOD,
  STRUCTURED_CALLS
} from './structured-agent-session-surface-calls'

let operations = 0

// Reset ids so one test’s envelopes cannot look like another test’s replays.
export function resetOperationIds(): void {
  operations = 0
}

/** `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. */
function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

export function envelope(args: {
  method: string
  fields: Record<string, unknown>
  fence: number | null
}): Record<string, unknown> {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: args.fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: args.method,
      sessionId: SESSION,
      fields: args.fields
    })
  }
}

export function attachParams(fence: number | null): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: THREAD }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

export function createIntentParams(): Record<string, unknown> {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'codex' }
  return { envelope: envelope({ method: 'agentSession.create', fields, fence: null }), ...fields }
}

// Use the production sender so old hosts receive the exact current fingerprinted wire shape.
export function sendParams(
  text: string,
  fence: number,
  sentDelivery?: 'queue-if-active',
  options?: Readonly<Record<string, string>>
): Record<string, unknown> {
  return structuredAgentSessionMessageSendMutation({
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    body: structuredAgentSessionSendBody(text, []),
    ...(sentDelivery ? { delivery: sentDelivery } : {}),
    ...(options ? { options } : {})
  })
}

/** Schema-valid params per method; values only need to survive validation. */
export function paramsFor(method: string): unknown {
  const fence = 1
  switch (method) {
    case 'agentSession.createSupport':
      return { worktree: `id:${WORKSPACE}`, agent: 'codex' }
    case 'agentSession.create':
      return createIntentParams()
    case 'agentSession.ensure':
      return attachParams(fence)
    case 'agentSession.conversationCommand': {
      const fields = { command: 'compact' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.send':
      return sendParams('hi', fence)
    case REWIND_METHOD: {
      const fields = { itemId: 'item-1', expectedEpoch: 'current-epoch' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.cancel':
      return {
        envelope: envelope({ method: 'agentSession.cancel', fields: { turnId: 'turn-1' }, fence }),
        turnId: 'turn-1'
      }
    case 'agentSession.queuedMessageSend':
    case 'agentSession.queuedMessageDelete': {
      const fields = { messageId: 'queued-1' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.queuedMessageMove': {
      const fields = { messageId: 'queued-1', beforeMessageId: null }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.queuedMessagesResume':
      return { envelope: envelope({ method, fields: {}, fence }) }
    case 'agentSession.queuedMessageUpdate': {
      const fields = { messageId: 'queued-1', expectedBodyFingerprint: 'a'.repeat(64), text: 'hi' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.queuedMessageEditHold':
      return {
        sessionId: SESSION,
        messageId: 'queued-1',
        editId: 'edit-1',
        action: 'acquire',
        expectedBodyFingerprint: 'a'.repeat(64)
      }
    case 'agentSession.respondToApproval':
    case 'agentSession.respondToQuestion': {
      const fields = { itemId: 'item-1', expectedRevision: 1, optionId: 'allow' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.setOption': {
      const fields = { key: 'model', value: 'gpt-5' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.threadGoal': {
      const fields = { change: { kind: 'set', objective: 'Ship the parser' } }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.history':
      return { sessionId: SESSION, direction: 'tail' }
    case ITEM_DETAIL_METHOD:
      return { sessionId: SESSION, itemId: 'item-1' }
    case 'agentSession.sleepWorkspace':
      return { workspaceId: WORKSPACE }
    case 'agentSession.currentRequests':
      return { sessionId: SESSION, version: '00000000-0000-4000-8000-000000000001' }
    case 'agentSession.acknowledgeAttention':
      return { ...ATTENTION_READ, observedCursor: { ...ATTENTION_READ.observedCursor } }
    case 'agentSession.modelCatalog':
      return { agent: 'codex', sessionId: SESSION }
    case 'agentSession.readVisual':
      return { sessionId: SESSION, file: 'usage-chart.html' }
    case 'agentSession.rename':
      return { sessionId: SESSION, name: 'Release notes' }
    case 'agentSession.hold':
    case 'agentSession.release':
      return { sessionId: SESSION, holderId: 'surface-1' }
    case 'agentSession.agents':
    case 'agentSession.subscribeAvailability':
    case 'agentSession.restartResumable':
    case 'agentSession.restartResumableDismiss':
    case 'agentSession.restartResume':
    case 'agentSession.restartContinue':
      // Whole-surface calls: they name no session, and resume/continue narrow by an optional list.
      return {}
    case 'agentSession.continueInterrupted':
      return { sessionId: SESSION, turnItemId: 'legacy:codex:s:turn-1' }
    default:
      return { sessionId: SESSION }
  }
}
