// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  createParams,
  created,
  submission,
  start,
  deferred
} from './structured-agent-session-launch-create-message.test-fixture'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  getStructuredLaunchStateBySessionId,
  setStructuredLaunchState,
  notifyStructuredLaunchListeners,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import {
  resetStructuredAgentSessionSendsForTests,
  settleStructuredAgentSessionSendsFromJournal
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  type StructuredAgentSessionPendingSend
} from '@/components/native-chat/structured-agent-session-pending-sends'

const KEY = 'orca:structuredAgentLaunches:v1'
const refusal = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    ownerVerdict: 'exited',
    details: { reason: 'cliMissing' }
  }
}
const diskOnly = {
  sessionId: 'disk-only',
  executionHostId: 'local' as const,
  agent: 'codex' as const,
  lifecycle: 'visibility-unknown' as const,
  clientOperationId: 'disk-operation',
  payloadFingerprint: 'disk-payload',
  expectedRuntimeFence: null
}
let restore: (() => void) | undefined
beforeEach(() => {
  mocks.settings = {}
  restore = resetCreateMessageFixture()
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanupCreateMessageFixture(restore)
})

function addFailedLaunches(template: StructuredLaunchState, count: number) {
  for (let index = 0; index < count; index++) {
    const sessionId = `failed-${index}`
    setStructuredLaunchState({
      ...template,
      visibilityUnknown: false,
      intent: { ...template.intent, sessionId },
      callers: { ...template.callers, outcome: 'failed', failedAt: 42, onSettled: () => {} }
    })
  }
  writeStructuredAgentLaunchRecord(diskOnly)
}

it('retains refused retry recovery alongside unrelated and disk-only launches', async () => {
  mocks.call.mockRejectedValue(new Error('answer lost'))
  const launch = start()
  await expect(launch.launchResult).rejects.toThrow('answer lost')
  await launch.promptDeliveryResult
  const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
  addFailedLaunches(state, 2)
  mocks.call.mockResolvedValue(refusal)
  expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
  await state.promise.catch(() => {})
  resetStructuredAgentLaunchPersistenceForTests()
  expect(readStructuredAgentLaunchRecord('disk-only')).toEqual({
    sessionId: 'disk-only',
    executionHostId: 'local',
    agent: 'codex',
    lifecycle: 'visibility-unknown',
    clientOperationId: 'disk-operation',
    payloadFingerprint: 'disk-payload',
    expectedRuntimeFence: null
  })
  for (const sessionId of ['failed-0', 'failed-1']) {
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject({
      sessionId,
      executionHostId: 'local',
      agent: 'codex',
      lifecycle: 'failed'
    })
  }
  expect(readStructuredAgentLaunchRecord(launch.sessionId)).toMatchObject({
    sessionId: launch.sessionId,
    executionHostId: 'local',
    agent: 'codex',
    firstMessage: {
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'opening text' }] }
    }
  })
})

it('settles a late receipt without consuming unrelated pending inputs', async () => {
  const first = deferred<unknown>()
  mocks.call.mockReturnValue(first.promise)
  const launch = start()
  await vi.waitFor(() => expect(createParams().firstMessage).toBeDefined())
  const original = createParams()
  await vi.advanceTimersByTimeAsync(30_000)
  await launch.promptDeliveryResult
  mocks.call.mockResolvedValue(refusal)
  retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)
  await getStructuredLaunchStateBySessionId(launch.sessionId)!.promise.catch(() => {})
  resetStructuredAgentSessionSendsForTests()
  const pending: StructuredAgentSessionPendingSend[] = ['unconfirmed-0', 'unconfirmed-1'].map(
    (clientMessageId) => ({
      clientMessageId,
      sessionId: launch.sessionId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'pending input' }] },
      phase: 'unconfirmed',
      issued: true,
      previewUris: [],
      queuedAt: 1
    })
  )
  publishStructuredAgentSessionSends(launch.sessionId, {
    entries: [
      ...pending,
      {
        ...pending[0],
        clientMessageId: 'covered',
        phase: 'recorded',
        recordedCursor: { epoch: 'epoch-1', sequence: 1 }
      }
    ]
  })
  const row = submission(original.firstMessage!.clientMessageId)
  first.resolve({
    ...created(original),
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: { ...created(original).value, firstMessage: row }
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(
    getStructuredAgentSessionPendingSends(launch.sessionId).map((send) => send.clientMessageId)
  ).toEqual(['unconfirmed-0', 'unconfirmed-1'])
  expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
  settleStructuredAgentSessionSendsFromJournal(launch.sessionId, [row], [])
  expect(
    getStructuredAgentSessionPendingSends(launch.sessionId).map((send) => send.clientMessageId)
  ).toEqual(['unconfirmed-0', 'unconfirmed-1'])
  expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
})

it('saves before reentrant listeners and still notifies when storage refuses a snapshot', async () => {
  mocks.call.mockRejectedValue(new Error('answer lost'))
  const launch = start()
  await expect(launch.launchResult).rejects.toThrow()
  await launch.promptDeliveryResult
  const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
  const originalOperation = state.intent.params.envelope.clientOperationId
  const seen: string[] = []
  const stop = subscribeStructuredAgentLaunchStatus(() => {
    seen.push(JSON.parse(localStorage.getItem(KEY)!)[0].clientOperationId)
    if (seen.length === 1) {
      state.intent.params.envelope.clientOperationId = 'nested-operation'
      notifyStructuredLaunchListeners()
    }
  })
  notifyStructuredLaunchListeners()
  expect(seen).toEqual([originalOperation, 'nested-operation'])
  expect(JSON.parse(localStorage.getItem(KEY)!)[0].clientOperationId).toBe('nested-operation')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
    throw new Error('storage denied')
  })
  state.intent.params.envelope.clientOperationId = 'after-failure'
  notifyStructuredLaunchListeners()
  expect(seen).toHaveLength(3)
  expect(warn).toHaveBeenCalledOnce()
  notifyStructuredLaunchListeners()
  expect(JSON.parse(localStorage.getItem(KEY)!)[0].clientOperationId).toBe('after-failure')
  stop()
})
