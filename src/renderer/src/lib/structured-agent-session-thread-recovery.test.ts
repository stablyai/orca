// @vitest-environment happy-dom
import './structured-agent-session-launch-create-message.test-fixture'
import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  createParams
} from './structured-agent-session-launch-create-message.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../main/native-chat/agent-session-wire/structured-agent-session-registry'
import { call } from '../../../main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { restorePersistedStructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-reload'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'

let rig: RestTestRig | undefined
let restore: (() => void) | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  cleanupCreateMessageFixture(restore)
})
it('replays a persisted thread opening after a lost create reply and settles the production dispatch exactly once', async () => {
  restore = resetCreateMessageFixture()
  vi.useRealTimers()
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  rig.clock.now = Date.now()
  setStructuredAgentSessionHost(rig.host)
  const client = {
    clientId: 'thread-recovery',
    clientKind: 'runtime' as const,
    clientCapabilities: [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
      AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
    ]
  }
  const dispatched = Promise.withResolvers<void>()
  const dispatch = rig.adapter.dispatch.getMockImplementation()
  if (!dispatch) {
    throw new Error('fixture dispatch missing')
  }
  rig.adapter.dispatch.mockImplementation(async (input) => {
    await dispatched.promise
    return dispatch(input)
  })
  let dropped = false
  mocks.call.mockImplementation(async (_target, method, params) => {
    const answer = await call(method, params, client)
    if (method === 'agentSession.create' && !dropped) {
      dropped = true
      return new Promise(() => {})
    }
    if (!answer.ok) {
      throw new Error(answer.error.message)
    }
    return answer.result
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    surface: 'thread',
    prompt: 'opening text',
    launchOptions: { model: 'gpt-5.6-sol' }
  })
  await vi.waitFor(() => expect(dropped).toBe(true))
  const original = structuredClone(createParams())
  const saved = readStructuredAgentLaunchRecord(launch.sessionId)
  expect(saved).toMatchObject({
    surface: 'thread',
    firstMessage: original.firstMessage,
    payloadFingerprint: original.envelope.payloadFingerprint
  })
  expect(rig.store.getRecord(launch.sessionId)?.surface).toBe('thread')
  await vi.waitFor(() => expect(rig!.adapter.dispatch).toHaveBeenCalledOnce())
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  const restored = restorePersistedStructuredLaunchState('workspace-1', launch.sessionId)
  expect(restored?.intent.params).toEqual(original)
  mocks.inventory.mockResolvedValue([])
  expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
  await vi.waitFor(() => expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined())
  dispatched.resolve()
  await vi.waitFor(async () =>
    expect((await rig!.host.journalSnapshot(launch.sessionId)).submissions).toMatchObject([
      { clientMessageId: original.firstMessage?.clientMessageId, dispatchState: 'accepted' }
    ])
  )
  expect(
    mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.create')
      .map(([, , params]) => params)
  ).toEqual([original, original])
  expect(rig.adapter.dispatch).toHaveBeenCalledOnce()
  expect((await rig.host.journalSnapshot(launch.sessionId)).submissions).toHaveLength(1)
  await rig.restart()
  setStructuredAgentSessionHost(rig.host)
  expect(rig.store.getRecord(launch.sessionId)?.surface).toBe('thread')
  await rig.host.seedSessionTabs()
  const summaries: AgentSessionStatusSummary[] = []
  const stop = rig.host.subscribeStatus({
    id: 'recovered-thread',
    emit: (event) => {
      if (event.type === 'snapshot') {
        summaries.push(...event.sessions)
      } else if (event.type === 'status') {
        summaries.push(event.session)
      }
    }
  })
  await vi.waitFor(() =>
    expect(summaries).toContainEqual(
      expect.objectContaining({ sessionId: launch.sessionId, surface: 'thread' })
    )
  )
  stop()
})
