// @vitest-environment happy-dom
import { CreateIntentParams } from '../../../../../shared/rpc-contract/structured-agent-session-params'
import type { AgentSessionWireRefusal } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  created
} from './structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'

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
import { callWebRuntimeEnvironment } from '@/web/preload-api/web-runtime-calls'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => {
  cleanupCreateMessageFixture(restore)
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCache()
})

const forkFrom = { sessionId: 'codex_source', throughItemId: 'item-reply-2' }

it('sends no fork to a host that does not advertise forks', async () => {
  mocks.exactSupport.mockResolvedValue(false)
  const launch = startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId: 'fork-action',
    executionHostId: 'local',
    forkFrom,
    forkRequiresInheritedOriginal: false
  })
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'structured_agent_session_fork_unsupported'
  })
  expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(false)
})

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

import type { callStructuredAgentSession as StructuredCall } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { callRuntimeRpc as RuntimeCall } from '@/runtime/rpc/calls/runtime-rpc-call'
// Real launch, capability cache, structured-call wrapper and RPC options, up to the IPC boundary.
import {
  compatibilityEntry,
  runtimeCompatibilityChecks,
  clearRuntimeCompatibilityCache
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-create-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import {
  launchAndReconcile,
  reconcileUnknownLaunch
} from './structured-agent-session-launch-recovery'
import {
  createStructuredAgentSessionLaunchIntent,
  retryStructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent
} from '@/lib/launch-structured-agent-session'

const { callStructuredAgentSession } = await vi.importActual<{
  callStructuredAgentSession: typeof StructuredCall
}>('@/runtime/native-chat/requests/structured-agent-session-call')
const { callRuntimeRpc } = await vi.importActual<{ callRuntimeRpc: typeof RuntimeCall }>(
  '@/runtime/rpc/calls/runtime-rpc-call'
)

async function remoteForkTransport() {
  vi.useRealTimers()
  mocks.exactSupport.mockResolvedValue(true)
  mocks.inventory.mockResolvedValue([])
  mocks.call.mockImplementation(
    (target, method, params, ...options: [Parameters<typeof StructuredCall>[3]?]) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production wrapper receives the typed launch target.
      return callStructuredAgentSession(target as RuntimeClientTarget, method, params, ...options)
    }
  )
  mocks.rpc.mockImplementation(callRuntimeRpc)
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 7, pairingRevision: 7 }])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the positive cache entry is consumed only for capability/compatibility.
  const status = {
    runtimeId: 'runtime-a',
    capabilities: [AGENT_SESSION_CREATE_FORK_ORIGINAL_RUNTIME_CAPABILITY]
  } as RuntimeStatus
  runtimeCompatibilityChecks.set('paired', compatibilityEntry(status))
  const call = vi.fn(async (request): Promise<RuntimeRpcResponse<unknown>> => {
    if (request.method !== 'agentSession.create') {
      throw new Error('No child read expected')
    }
    return { id: request.method, ok: true, result: created(), _meta: { runtimeId: 'runtime-a' } }
  })
  vi.stubGlobal('window', { ...window, api: { ...window.api, runtimeEnvironments: { call } } })
  return call
}
function inheritedIntent() {
  const intent = createStructuredAgentSessionLaunchIntent(
    'workspace-fork',
    'opencode',
    'runtime:paired',
    undefined,
    undefined,
    true,
    { sessionId: 'copied-chat', throughItemId: 'legacy:opencode:source:reply-1' }
  )
  intent.forkRequiresInheritedOriginal = true
  return intent
}
function recoveryState(intent = inheritedIntent()) {
  return {
    intent,
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false
  }
}
const restartedRuntime = {
  id: 'agentSession.create',
  ok: false,
  error: {
    code: 'runtime_environment_changed',
    message: 'Runtime environment identity changed; refresh and try again'
  },
  _meta: { runtimeId: 'runtime-b' }
} as const

it('settles a pinned pre-dispatch runtime replacement definitively, and keeps the requirement on Retry', async () => {
  const call = await remoteForkTransport()
  // Recorded no-send response from the sending-socket guard, exercised in the transport suites.
  call.mockResolvedValueOnce(restartedRuntime)
  const launch = startStructuredAgentLaunch('workspace-fork', 'opencode', {
    requestId: 'bound-fork',
    executionHostId: 'runtime:paired',
    forkFrom: { sessionId: 'copied-chat', throughItemId: 'legacy:opencode:source:reply-1' },
    forkRequiresInheritedOriginal: true
  })
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'runtime_unavailable'
  })
  expect(launch.isVisibilityUnknown()).toBe(false)
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
    'failed'
  )
  expect(call).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'agentSession.create',
      expectedEnvironmentRuntimeId: 'runtime-a',
      expectedEnvironmentPairingRevision: 7
    })
  )

  // Each retry must reacquire proof rather than retain the prior runtime tuple.
  const current = runtimeCompatibilityChecks.get('paired')!
  runtimeCompatibilityChecks.set(
    'paired',
    compatibilityEntry({ ...current.status!, runtimeId: 'runtime-c' })
  )
  const state = recoveryState(retryStructuredAgentSessionLaunchIntent(inheritedIntent()))
  await expect(launchAndReconcile(state)).resolves.toMatchObject({ fence: 1 })
  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: 'agentSession.create',
      expectedEnvironmentRuntimeId: 'runtime-c',
      expectedEnvironmentPairingRevision: 7,
      params: expect.objectContaining({
        forkFrom: { sessionId: 'copied-chat', throughItemId: 'legacy:opencode:source:reply-1' }
      })
    })
  )
  runtimeCompatibilityChecks.set(
    'paired',
    compatibilityEntry({ ...current.status!, capabilities: [] })
  )
  await expect(launchAndReconcile(recoveryState(inheritedIntent()))).rejects.toMatchObject({
    code: 'structured_agent_session_fork_unsupported'
  })
  const ordinary = createStructuredAgentSessionLaunchIntent(
    'workspace-fork',
    'opencode',
    'runtime:paired',
    undefined,
    undefined,
    true,
    { sessionId: 'child', throughItemId: 'legacy:opencode:child:reply-2' }
  )
  ordinary.forkRequiresInheritedOriginal = false
  await expect(launchAndReconcile(recoveryState(ordinary))).resolves.toMatchObject({ fence: 1 })
})

it('reconciles a lost create first and retains uncertainty when a later proof cannot send', async () => {
  const call = await remoteForkTransport()
  const state = recoveryState()
  call.mockImplementationOnce(async () => {
    clearRuntimeCompatibilityCache()
    throw new Error('create reply lost')
  })
  await expect(launchAndReconcile(state)).rejects.toMatchObject({ code: 'runtime_unavailable' })
  expect(state.visibilityUnknown).toBe(true)
  // Once publication arrives, recovery succeeds even though the capability read would still fail.
  mocks.inventory.mockResolvedValue([
    {
      worktree: 'workspace-fork',
      tabs: [{ type: 'agent-session', sessionId: state.intent.sessionId }]
    }
  ])
  mocks.call.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.history') {
      return { ok: true, page: { ...created().value.page, sessionId: state.intent.sessionId } }
    }
    throw new Error('No create or capability read during reconciliation')
  })
  await expect(reconcileUnknownLaunch(state, true)).resolves.toMatchObject({
    sessionId: state.intent.sessionId,
    fence: 1
  })
})

it('rederives a restored ancestor fork requirement from the child before resubmitting', async () => {
  const call = await remoteForkTransport()
  const prior = inheritedIntent()
  const restored = restoreStructuredAgentSessionLaunchIntent({
    worktreeId: prior.worktreeId,
    executionHostId: prior.executionHostId,
    agent: prior.agent,
    ...prior.params.envelope,
    forkFrom: prior.params.forkFrom
  })
  const base = created(CreateIntentParams.parse(prior.params)).value.page
  mocks.call.mockImplementation(
    async (target, method, params, ...rest: [Parameters<typeof StructuredCall>[3]?]) => {
      if (method === 'agentSession.agents') {
        return { agents: [{ agent: 'opencode', capabilities: { fork: 'tip' } }] }
      }
      if (method === 'agentSession.history') {
        return {
          ok: true,
          page: {
            ...base,
            sessionId: 'copied-chat',
            items: [
              {
                itemId: 'source-u1',
                sequence: 1,
                body: { kind: 'message', role: 'user', blocks: [] }
              },
              {
                itemId: 'legacy:opencode:source:reply-1',
                sequence: 2,
                body: { kind: 'message', role: 'assistant', blocks: [] }
              },
              {
                itemId: 'parent-fork-u2',
                sequence: 3,
                body: { kind: 'message', role: 'user', blocks: [] }
              },
              {
                itemId: 'legacy:opencode:parent-fork:reply-2',
                sequence: 4,
                body: { kind: 'message', role: 'assistant', blocks: [] }
              },
              {
                itemId: 'orca:forked-from',
                sequence: 5,
                body: { kind: 'status', presentation: 'forked-from', text: 'Forked from source' }
              },
              {
                itemId: 'child-u3',
                sequence: 6,
                body: { kind: 'message', role: 'user', blocks: [] }
              },
              {
                itemId: 'legacy:opencode:child:reply-3',
                sequence: 7,
                body: { kind: 'message', role: 'assistant', blocks: [] }
              }
            ]
          }
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production wrapper receives the typed launch target.
      return callStructuredAgentSession(target as RuntimeClientTarget, method, params, ...rest)
    }
  )
  await expect(reconcileUnknownLaunch(recoveryState(restored), true)).resolves.toMatchObject({
    fence: 1
  })
  expect(call).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedEnvironmentRuntimeId: 'runtime-a',
      expectedEnvironmentPairingRevision: 7
    })
  )
})

it('settles a browser pin refusal before dispatch but keeps a lost browser reply uncertain', async () => {
  const call = await remoteForkTransport()
  call.mockImplementation(callWebRuntimeEnvironment)
  browserSession.client.connectionEpoch = 1
  browserSession.client.call.mockReset()
  browserSession.client.call.mockImplementation(async (method) => {
    if (method !== 'status.get') {
      throw new Error('Unexpected create dispatch')
    }
    return { id: 'status', ok: true, result: {}, _meta: { runtimeId: 'runtime-b' } }
  })
  const state = recoveryState()
  await expect(launchAndReconcile(state)).rejects.toMatchObject({
    code: 'runtime_unavailable'
  })
  expect(state.visibilityUnknown).toBe(false)
  expect(browserSession.client.call.mock.calls.map(([method]) => method)).not.toContain(
    'agentSession.create'
  )

  // The same words in a failed reply are not pre-dispatch evidence.
  browserSession.client.connectionEpoch = 2
  browserSession.client.call.mockImplementation(async (method) => {
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: {}, _meta: { runtimeId: 'runtime-a' } }
    }
    throw new Error('Runtime connection changed; try again.')
  })
  const lost = recoveryState()
  await expect(launchAndReconcile(lost)).rejects.toThrow()
  expect(lost.visibilityUnknown).toBe(true)
})

it('keeps a failed capability read definitive without classifying the host as unsupported', async () => {
  const call = await remoteForkTransport()
  clearRuntimeCompatibilityCache()
  call.mockRejectedValue(new Error('status read failed'))
  const state = recoveryState()
  await expect(launchAndReconcile(state)).rejects.toMatchObject({ code: 'runtime_unavailable' })
  expect(state.visibilityUnknown).toBe(false)
  expect(call.mock.calls.map(([request]) => request.method)).not.toContain('agentSession.create')
})
