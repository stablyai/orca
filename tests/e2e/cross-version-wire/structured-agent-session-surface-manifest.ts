// What the structured `agentSession.*` surface IS, and how to call each method.
//
// Split from the skew scenarios so the manifest stays readable as it grows: this file answers
// "which methods exist, what each must reach and return, and what params it takes"; the suite
// next to it answers "what happens when the two builds disagree".
//
// Adding a method here is the deliberate act the cross-version gate exists to force. A new entry
// makes the suite call it in both skew directions, so an addition cannot land without someone
// stating what an older peer does with it.

import { attachFingerprintFields } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import type { AgentSessionAttachParams } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-attach'
import { computeAgentSessionPayloadFingerprint } from '../../../src/shared/agent-session-mutation-envelope'

export const SESSION = 'session-alpha'
export const WORKSPACE = 'workspace-1'
export const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
export const NOW = 1_800_000_000_000
export const REWIND_METHOD = 'agentSession.rewind'
export const STATUS_FEED_METHOD = 'agentSession.subscribeStatus'

let operations = 0

/** Each test starts the ledger's operation ids from zero, so one test's envelopes cannot be
 *  mistaken for a replay of another's. */
export function resetOperationIds(): void {
  operations = 0
}

/** `<13-digit ms>-<32 hex>`, the only shape the durable ledger accepts. */
function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

/** Every method the structured surface publishes: the host method it must reach,
 *  and the result it must hand back. A gate that hides one method and leaks
 *  another is the bug; so is a method that is registered and answers with an
 *  error, which is why `result` is declared per method rather than inferred from
 *  "did not say method_not_found". `result` is omitted only where the method
 *  legitimately answers with no reply at all. */
export const STRUCTURED_CALLS: {
  method: string
  hostMethod: string | null
  result?: Record<string, unknown>
}[] = [
  { method: 'agentSession.createSupport', hostMethod: null, result: { supported: true } },
  {
    method: 'agentSession.create',
    hostMethod: 'attach',
    result: { ok: true, replayed: false, value: { sessionId: SESSION } }
  },
  {
    method: 'agentSession.ensure',
    hostMethod: 'attach',
    result: { ok: true, replayed: false, value: { sessionId: SESSION } }
  },
  {
    method: 'agentSession.conversationCommand',
    hostMethod: 'conversationCommand',
    result: { ok: true, value: { command: 'compact', state: 'completed' } }
  },
  { method: 'agentSession.send', hostMethod: 'send', result: { ok: true, replayed: false } },
  { method: 'agentSession.cancel', hostMethod: 'cancel', result: { ok: true, replayed: false } },
  {
    method: REWIND_METHOD,
    hostMethod: 'rewind',
    result: { ok: true, replayed: false, value: { itemId: 'item-1', epoch: 'rewound-epoch' } }
  },
  { method: 'agentSession.close', hostMethod: 'close', result: { ok: true } },
  {
    method: 'agentSession.respondToApproval',
    hostMethod: 'respondToPrompt',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.respondToQuestion',
    hostMethod: 'respondToPrompt',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.setOption',
    hostMethod: 'setOption',
    result: { ok: true, replayed: false }
  },
  {
    method: 'agentSession.requestHandoff',
    hostMethod: 'requestHandoff',
    result: { status: { owner: 'native' } }
  },
  {
    method: 'agentSession.handoffStatus',
    hostMethod: 'handoffStatus',
    result: { owner: 'native' }
  },
  {
    method: 'agentSession.options',
    hostMethod: 'readOptions',
    result: { current: { model: 'gpt-live' } }
  },
  {
    method: 'agentSession.commands',
    hostMethod: 'readCommands',
    result: { commands: [{ name: 'clear', kind: 'command' }] }
  },
  {
    method: 'agentSession.reveal',
    hostMethod: 'revealSession',
    result: { ok: true, sessionId: SESSION, workspaceId: WORKSPACE, agent: 'codex', readable: true }
  },
  { method: 'agentSession.hold', hostMethod: 'hold', result: { held: true } },
  // The restart-resume surface. Bare additions, not capability-negotiated: an RPC method's
  // absence is explicit (`method_not_found`), which the old-dispatcher case below asserts, so a
  // newer client learns it during negotiation instead of by being met with silence.
  {
    method: 'agentSession.restartResumable',
    hostMethod: 'restartResumableList',
    result: { sessions: [] }
  },
  {
    method: 'agentSession.restartResumableDismiss',
    hostMethod: 'restartResumableDismiss',
    result: { dismissed: 0 }
  },
  {
    method: 'agentSession.restartResume',
    hostMethod: 'restartResumeAll',
    result: { results: [] }
  },
  {
    method: 'agentSession.restartContinue',
    hostMethod: 'restartContinueAll',
    result: { resumed: [], continued: [] }
  },
  { method: 'agentSession.release', hostMethod: 'release', result: { released: true } },
  {
    method: 'agentSession.history',
    hostMethod: 'history',
    result: { ok: true, page: { items: [] } }
  },
  // A subscription that opens with nothing to say answers with no reply at all,
  // so reaching the host is the only signal that the gate opened.
  { method: 'agentSession.subscribe', hostMethod: 'subscribe' },
  // The status feed opens with a snapshot of every session, so its first reply is the contract.
  {
    method: STATUS_FEED_METHOD,
    hostMethod: 'subscribeStatus',
    result: { type: 'snapshot', sessions: [] }
  },
  // Teardown runs through the runtime's subscription registry rather than the
  // host, so its reply is the only signal that the gate opened.
  { method: 'agentSession.unsubscribe', hostMethod: null, result: { unsubscribed: true } }
]

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

export function attachParams(fence: number | null): Record<string, unknown> {
  const params = {
    envelope: { sessionId: SESSION, clientOperationId: operationId(), expectedRuntimeFence: fence },
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
        fields: attachFingerprintFields(params as unknown as AgentSessionAttachParams)
      })
    }
  }
}

export function createIntentParams(): Record<string, unknown> {
  const worktree = `id:${WORKSPACE}`
  const fields = { worktree, agent: 'codex' }
  return { envelope: envelope({ method: 'agentSession.create', fields, fence: null }), ...fields }
}

export function sendParams(text: string, fence: number): Record<string, unknown> {
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  return { envelope: envelope({ method: 'agentSession.send', fields: { body }, fence }), body }
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
    case 'agentSession.respondToApproval':
    case 'agentSession.respondToQuestion': {
      const fields = { itemId: 'item-1', expectedRevision: 1, optionId: 'allow' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.requestHandoff': {
      const fields = {
        direction: 'to-tui' as const,
        mode: 'now' as const,
        action: 'start' as const
      }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.setOption': {
      const fields = { key: 'model', value: 'gpt-5' }
      return { envelope: envelope({ method, fields, fence }), ...fields }
    }
    case 'agentSession.history':
      return { sessionId: SESSION, direction: 'tail' }
    case 'agentSession.hold':
    case 'agentSession.release':
      return { sessionId: SESSION, holderId: 'surface-1' }
    case 'agentSession.restartResumable':
    case 'agentSession.restartResumableDismiss':
    case 'agentSession.restartResume':
    case 'agentSession.restartContinue':
      // Whole-surface calls: they name no session, and resume/continue narrow by an optional list.
      return {}
    default:
      return { sessionId: SESSION }
  }
}
