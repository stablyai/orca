// @vitest-environment happy-dom
import '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture
} from './structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import '@/web/preload-api/web-runtime-calls'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import './structured-agent-session-launch-recovery'
import '@/lib/agent-session/launch/structured-agent-session-launch-intent'
import type { AgentSessionWireRefusal } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { callStructuredAgentSession as StructuredCall } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { callRuntimeRpc as RuntimeCall } from '@/runtime/rpc/calls/runtime-rpc-call'

const browserSession = vi.hoisted(() => ({
  client: { connectionEpoch: 1, call: vi.fn() },
  environment: { id: 'paired', createdAt: 7, pairingRevision: 7 }
}))
vi.mock('@/web/preload-api/web-runtime-session', () => ({
  getClientForEnvironment: () => browserSession.client,
  manuallyDisconnectedEnvironmentIds: new Set<string>(),
  manuallyDisconnectedResponse: () => ({ ok: false }),
  resolveEnvironment: () => browserSession.environment,
  runtimeCallQueuePool: { enqueue: (_id: string, _method: string, run: () => unknown) => run() },
  updateEnvironmentFromResponse: () => undefined
}))

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => {
  cleanupCreateMessageFixture(restore)
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCache()
})

void { sessionId: 'codex_source', throughItemId: 'item-reply-2' }

const copiedReply = {
  sessionId: 'copied-chat',
  throughItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
}
function forkLaunch(requestId: string) {
  vi.useRealTimers()
  mocks.exactSupport.mockResolvedValue(true)
  mocks.inventory.mockResolvedValue([])
  return startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId,
    executionHostId: 'local',
    forkFrom: copiedReply,
    forkRequiresInheritedOriginal: false
  })
}

// Recorded create replies from the host's fork source-admission and post-copy paths.
const missingOriginal = {
  ok: false,
  refusal: {
    code: 'agent_session_identity_required',
    details: { reason: 'recordMissing' },
    createAttemptRefusedBeforeCommit: true,
    message: 'Codex could not find this response in the original chat. Open it and fork from there.'
  }
} as const
const changedOriginal = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    details: { reason: 'savedConversationMissing' },
    message: 'Codex could not find this response in the original chat. Open it and fork from there.'
  }
} as const

function returnCreateRefusal(refusal: { ok: false; refusal: AgentSessionWireRefusal }) {
  mocks.call.mockImplementation(async (_target, method) => {
    if (method !== 'agentSession.create') {
      throw new Error('No destination published')
    }
    return refusal
  })
}

it('settles proven missing and rewound-original refusals without an unknown destination', async () => {
  returnCreateRefusal(missingOriginal)
  const missing = forkLaunch('missing-original')
  await expect(missing.launchResult).rejects.toMatchObject({
    code: 'agent_session_identity_required',
    refusal: { details: { reason: 'recordMissing' } }
  })
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', missing.sessionId)).toBe(
    'failed'
  )
  expect(missing.isVisibilityUnknown()).toBe(false)
  returnCreateRefusal({
    ...changedOriginal,
    refusal: { ...changedOriginal.refusal, createAttemptRefusedBeforeCommit: true }
  })
  const removed = forkLaunch('removed-original-reply')
  await expect(removed.launchResult).rejects.toMatchObject({
    code: 'agent_session_operation_invalid',
    refusal: { details: { reason: 'savedConversationMissing' } }
  })
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', removed.sessionId)).toBe(
    'failed'
  )
  expect(removed.isVisibilityUnknown()).toBe(false)
})

it('keeps a post-copy source refusal uncertain without source-admission proof', async () => {
  returnCreateRefusal(changedOriginal)
  const launch = forkLaunch('post-copy-source-change')
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'agent_session_operation_invalid'
  })
  expect(launch.isVisibilityUnknown()).toBe(true)
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
    'visibility-unknown'
  )
})

it('keeps an earlier lost create unknown when the retry proves the original is missing', async () => {
  returnCreateRefusal(missingOriginal)
  mocks.call.mockRejectedValueOnce(new Error('create reply lost'))
  const launch = forkLaunch('lost-before-source-refusal')
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'agent_session_identity_required'
  })
  expect(launch.isVisibilityUnknown()).toBe(true)
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
    'visibility-unknown'
  )
})

// Real launch, capability cache, structured-call wrapper and RPC options, up to the IPC boundary.

void (
  await vi.importActual<{
    callStructuredAgentSession: typeof StructuredCall
  }>('@/runtime/native-chat/requests/structured-agent-session-call')
).callStructuredAgentSession
void (
  await vi.importActual<{ callRuntimeRpc: typeof RuntimeCall }>(
    '@/runtime/rpc/calls/runtime-rpc-call'
  )
).callRuntimeRpc

void ({
  id: 'agentSession.create',
  ok: false,
  error: {
    code: 'runtime_environment_changed',
    message: 'Runtime environment identity changed; refresh and try again'
  },
  _meta: { runtimeId: 'runtime-b' }
} as const)
