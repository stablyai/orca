// @vitest-environment happy-dom
import '../../../../../types/build-constants.d.ts'
import { createRestTestRig } from '../../../../../main/native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import { forkTestSource } from '../../../../../main/native-chat/agent-session-wire/acquisition/testing/structured-agent-session-fork.test-fixture'
import { agentSessionRecordFixture } from '../../../../../main/native-chat/agent-session-record-test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../../../../../main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../../../../main/runtime/orca-runtime'
import { resolveStructuredAgentSessionForkIntent } from '../../../../../main/native-chat/agent-session-wire/acquisition/structured-agent-session-fork-intent'
import { EVERY_AGENT_CHAT } from '../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { handleStructuredAgentSessionCreate } from '../../../../../main/runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create-handler'
import { CreateIntentParams } from '../../../../../shared/rpc-contract/structured-agent-session-params'
import { getStructuredAgentSessionLaunchLifecycle } from './structured-agent-session-launch-registry'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture
} from './structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => cleanupCreateMessageFixture(restore))

const forkFrom = { sessionId: 'codex_source', throughItemId: 'item-reply-2' }

it('sends no fork to a host that does not advertise forks', async () => {
  mocks.exactSupport.mockResolvedValue(false)
  const launch = startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId: 'fork-action',
    executionHostId: 'local',
    forkFrom
  })
  await expect(launch.launchResult).rejects.toMatchObject({
    code: 'structured_agent_session_fork_unsupported'
  })
  expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(false)
})

async function forkHost() {
  vi.useRealTimers()
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const test = forkTestSource(rig)
  test.snapshot.items[2]!.itemId = 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1'
  const child = agentSessionRecordFixture({
    ...test.record,
    sessionId: 'copied-chat',
    providerHandleChain: [
      {
        ...test.record.providerHandleChain[0]!,
        handle: codexProviderHandle('019e6b26-18e2-7103-b7a0-7ba6bb071124')
      }
    ],
    forkedFrom: {
      sessionId: 'source-chat',
      itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071123:completed-turn:1',
      childBoundary: {
        kind: 'item',
        itemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
      }
    }
  })
  const childSnapshot = {
    ...structuredClone(test.snapshot),
    sessionId: child.sessionId,
    items: test.snapshot.items.map((item) => ({
      ...item,
      itemId: item.itemId.replace(
        '019e6b26-18e2-7103-b7a0-7ba6bb071123',
        '019e6b26-18e2-7103-b7a0-7ba6bb071124'
      )
    }))
  }
  const records = new Map([
    ['copied-chat', child],
    ['source-chat', test.record]
  ])
  const getRecord = rig.store.getRecord.bind(rig.store)
  const select = rig.store.selectWritableRecord.bind(rig.store)
  const writable = rig.store.requireWritableRecord.bind(rig.store)
  vi.spyOn(rig.store, 'getRecord').mockImplementation((id) => records.get(id) ?? getRecord(id))
  vi.spyOn(rig.store, 'requireWritableRecord').mockImplementation(
    (id) => records.get(id) ?? writable(id)
  )
  vi.spyOn(rig.store, 'selectWritableRecord').mockImplementation((id) =>
    records.has(id) ? { kind: 'writable', record: records.get(id)! } : select(id)
  )
  const snapshot = rig.host.journalSnapshot.bind(rig.host)
  vi.spyOn(rig.host, 'journalSnapshot').mockImplementation((id) =>
    id === 'copied-chat'
      ? Promise.resolve(childSnapshot)
      : id === 'source-chat'
        ? Promise.resolve(test.snapshot)
        : snapshot(id)
  )
  const capabilities = rig.host.deps.agents.capabilities.bind(rig.host.deps.agents)
  vi.spyOn(rig.host.deps.agents, 'capabilities').mockImplementation((agent) => {
    const supported = capabilities(agent)
    return supported ? { ...supported, fork: 'checkpoint' } : null
  })
  rig.host.deps.adapter.copyConversation = test.copy
  setStructuredAgentSessionHost(rig.host)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the facade supplies every runtime method used before the fork refuses.
  const runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }),
    resolveStructuredAgentSessionCreateIntent: async (
      input: Parameters<OrcaRuntimeService['resolveStructuredAgentSessionCreateIntent']>[0]
    ) => {
      if (!input.forkFrom) {
        throw new Error('Expected a fork intent')
      }
      return resolveStructuredAgentSessionForkIntent({
        ...input,
        forkFrom: input.forkFrom,
        host: rig.host,
        location: test.record.location
      })
    },
    publishStructuredAgentSessionTab: vi.fn(async () => undefined)
  } as unknown as OrcaRuntimeService
  mocks.exactSupport.mockResolvedValue(true)
  mocks.inventory.mockResolvedValue([])
  const create = async (_target: unknown, method: string, params: unknown) => {
    if (method !== 'agentSession.create') {
      throw new Error('No destination published')
    }
    return handleStructuredAgentSessionCreate(CreateIntentParams.parse(params), {
      runtime,
      clientId: 'device-1'
    })
  }
  mocks.call.mockImplementation(create)
  return { rig, test, records, create }
}

const copiedReply = {
  sessionId: 'copied-chat',
  throughItemId: 'codex:019e6b26-18e2-7103-b7a0-7ba6bb071124:completed-turn:1'
}
function forkLaunch(requestId: string) {
  return startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId,
    executionHostId: 'local',
    forkFrom: copiedReply
  })
}

it('settles missing and rewound-original refusals through create without an unknown destination', async () => {
  const { rig, test, records } = await forkHost()
  try {
    records.delete('source-chat')
    const missing = forkLaunch('missing-original')
    await expect(missing.launchResult).rejects.toMatchObject({
      code: 'agent_session_identity_required',
      refusal: { details: { reason: 'recordMissing' } }
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', missing.sessionId)).toBe(
      'failed'
    )
    expect(missing.isVisibilityUnknown()).toBe(false)
    expect(rig.store.getRecord(missing.sessionId)).toBeNull()
    records.set('source-chat', test.record)
    test.snapshot.items = test.snapshot.items.slice(0, 1)
    const removed = forkLaunch('removed-original-reply')
    await expect(removed.launchResult).rejects.toMatchObject({
      code: 'agent_session_operation_invalid',
      refusal: { details: { reason: 'savedConversationMissing' } }
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', removed.sessionId)).toBe(
      'failed'
    )
    expect(removed.isVisibilityUnknown()).toBe(false)
    expect(rig.store.getRecord(removed.sessionId)).toBeNull()
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})

it('keeps a changed source after copying uncertain, despite a later admission refusal', async () => {
  const { rig, test } = await forkHost()
  try {
    const nativeCopy = test.copy.getMockImplementation()!
    test.copy.mockImplementationOnce(async (input) => {
      const copy = await nativeCopy(input)
      test.snapshot.items = test.snapshot.items.slice(0, 1)
      return copy
    })
    const launch = forkLaunch('post-copy-source-change')
    await expect(launch.launchResult).rejects.toMatchObject({
      code: 'agent_session_operation_invalid'
    })
    expect(launch.isVisibilityUnknown()).toBe(true)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
      'visibility-unknown'
    )
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})

it('keeps an earlier lost create unknown when the retry proves the original is missing', async () => {
  const { rig, records, create } = await forkHost()
  try {
    records.delete('source-chat')
    mocks.call.mockRejectedValueOnce(new Error('create reply lost')).mockImplementation(create)
    const launch = forkLaunch('lost-before-source-refusal')
    await expect(launch.launchResult).rejects.toMatchObject({
      code: 'agent_session_identity_required'
    })
    expect(launch.isVisibilityUnknown()).toBe(true)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-fork', launch.sessionId)).toBe(
      'visibility-unknown'
    )
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})
