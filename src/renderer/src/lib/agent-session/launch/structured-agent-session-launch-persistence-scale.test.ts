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
} from '../../structured-agent-session-launch-create-message.test-fixture'
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
  subscribeToStructuredAgentSessionPendingSends,
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

it.each([10, 100])(
  'writes one aggregate per Retry notification with %i other launches',
  async (count) => {
    mocks.call.mockRejectedValue(new Error('answer lost'))
    const launch = start()
    await expect(launch.launchResult).rejects.toThrow()
    await launch.promptDeliveryResult
    const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
    addFailedLaunches(state, count)
    const before = JSON.parse(localStorage.getItem(KEY)!)
    mocks.call.mockResolvedValue(refusal)
    const writes = vi.spyOn(localStorage, 'setItem')
    const serializations = vi.spyOn(JSON, 'stringify')
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await state.promise.catch(() => {})
    const snapshots = writes.mock.calls.filter(([key]) => key === KEY).map(([, value]) => value)
    // Restart and retained refusal each require one synchronous aggregate snapshot, independent of N.
    expect(snapshots).toHaveLength(2)
    const aggregateSerializations = serializations.mock.calls.filter(
      ([value]) => Array.isArray(value) && value.some((record) => record?.sessionId === 'disk-only')
    )
    expect(aggregateSerializations).toHaveLength(2)
    expect(aggregateSerializations.map(([value]) => value.length)).toEqual([count + 2, count + 2])
    const after = JSON.parse(localStorage.getItem(KEY)!)
    expect(after).toEqual(
      before.map((record: { sessionId: string }) =>
        record.sessionId === launch.sessionId
          ? { ...record, clientOperationId: state.intent.params.envelope.clientOperationId }
          : record
      )
    )
    resetStructuredAgentLaunchPersistenceForTests()
    expect(readStructuredAgentLaunchRecord('disk-only')).toEqual(diskOnly)
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
      createParams().firstMessage
    )
  }
)

it.each([10, 100])(
  'bounds late receipt settlement with %i unrelated pending inputs',
  async (count) => {
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
    let visits = 0
    const pending = Array.from(
      { length: count },
      (_, index): StructuredAgentSessionPendingSend => ({
        get clientMessageId() {
          visits++
          return `unconfirmed-${index}`
        },
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
    visits = 0
    const published = vi.fn()
    const notified = vi.fn()
    const stopSend = subscribeToStructuredAgentSessionPendingSends(launch.sessionId, published)
    const stopLaunch = subscribeStructuredAgentLaunchStatus(notified)
    const row = submission(original.firstMessage!.clientMessageId)
    first.resolve({
      ...created(original),
      cursor: { epoch: 'epoch-1', sequence: 1 },
      value: { ...created(original).value, firstMessage: row }
    })
    await vi.advanceTimersByTimeAsync(0)
    // One owner lookup, two evidence lookups and one removal rebuild per unrelated input (K=1).
    expect(visits).toBeLessThanOrEqual(4 * count)
    expect(published).toHaveBeenCalledOnce()
    expect(notified).toHaveBeenCalledOnce()
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual(pending)
    expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    published.mockClear()
    notified.mockClear()
    settleStructuredAgentSessionSendsFromJournal(launch.sessionId, [row], [])
    expect(published).not.toHaveBeenCalled()
    expect(notified).not.toHaveBeenCalled()
    stopSend()
    stopLaunch()
  }
)

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
