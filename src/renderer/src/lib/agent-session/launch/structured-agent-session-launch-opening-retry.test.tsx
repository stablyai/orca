// @vitest-environment happy-dom
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  createParams,
  created,
  submission,
  start,
  draft,
  deferred
} from '../../structured-agent-session-launch-create-message.test-fixture'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch,
  cancelStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredLaunchStateBySessionId,
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredAgentSessionLaunchFailure
} from './structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import { recheckUnconfirmedStructuredAgentLaunches } from './structured-agent-session-launch-unconfirmed-recheck'
import { markStructuredAgentSessionLaunchPublished } from './structured-agent-session-launch-publication'
import {
  settleStructuredAgentSessionSendsFromJournal,
  resetStructuredAgentSessionSendsForTests
} from '@/components/native-chat/structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import { NativeChatComposerNotices } from '@/components/native-chat/NativeChatComposerNotices'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { CreateIntentParams } from '../../../../../shared/rpc-contract/structured-agent-session-params'

let restore: (() => void) | undefined
beforeEach(() => {
  mocks.settings = {}
  restore = resetCreateMessageFixture()
})
afterEach(() => {
  cleanup()
  cleanupCreateMessageFixture(restore)
})

function LaunchNotice({ sessionId }: { sessionId: string }) {
  const launch = useNativeChatProvisionalLaunch('workspace-1', sessionId)
  return (
    <NativeChatComposerNotices
      notices={structuredSessionNotices({
        launch,
        agentLabel: 'Codex',
        sessionError: null,
        composerError: null
      })}
    />
  )
}

it.each(['memory', 'disk'])(
  'retries an absent opening with its frozen payload after %s recovery',
  async (source) => {
    mocks.settings = { nativeChatSessionOptions: { codex: { model: 'saved-model' } } }
    mocks.call.mockRejectedValue(new Error('connection lost before delivery'))
    const launch = start()
    await expect(launch.launchResult).rejects.toThrow()
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ unconfirmed: true })
    const original = createParams()
    if (source === 'disk') {
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      resetStructuredAgentSessionSendsForTests()
    }
    mocks.settings = { nativeChatSessionOptions: { codex: { model: 'changed-model' } } }
    mocks.supports.mockResolvedValue(false)
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.create') {
        throw new Error('no host record')
      }
      return created(CreateIntentParams.parse(params))
    })
    markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
    recheckUnconfirmedStructuredAgentLaunches('local')
    await vi.advanceTimersByTimeAsync(0)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(
      mocks.call.mock.calls
        .filter(([, method]) => method === 'agentSession.create')
        .map(([, , params]) => params)
    ).toEqual([original])
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
    const attempts = mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.create')
      .map(([, , params]) => CreateIntentParams.parse(params))
    expect(attempts[1]).toEqual({
      ...original,
      envelope: { ...original.envelope, clientOperationId: expect.any(String) }
    })
    expect(attempts[1]?.envelope.clientOperationId).not.toBe(original.envelope.clientOperationId)
    expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
    expect(draft(launch.sessionId)).toBe('')
    mocks.settings = {}
  }
)

it.each([
  { cancel: false, proof: 'journal' },
  { cancel: true, proof: 'journal' },
  { cancel: false, proof: 'receipt' },
  { cancel: true, proof: 'receipt' }
])(
  'keeps uncertain input through refusal, then accepts late $proof (cancel=$cancel)',
  async ({ cancel, proof }) => {
    const first = deferred<unknown>()
    mocks.call.mockReturnValue(first.promise)
    const launch = start()
    await vi.waitFor(() => expect(createParams().firstMessage).toBeDefined())
    const original = createParams()
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ unconfirmed: true })
    writeNativeChatDraftCache(structuredAgentSessionDraftScopeKey(launch.sessionId), 'newer draft')
    const refusal = {
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        ownerVerdict: 'exited',
        details: { reason: 'cliMissing' }
      }
    }
    mocks.call.mockResolvedValue(refusal)
    render(<LaunchNotice sessionId={launch.sessionId} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await getStructuredLaunchStateBySessionId(launch.sessionId)?.promise.catch(() => {})
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(
      getStructuredAgentSessionLaunchFailure('workspace-1', launch.sessionId)?.details?.reason
    ).toBe('cliMissing')
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.lifecycle).toBe('visibility-unknown')
    expect(draft(launch.sessionId)).toBe('newer draft')
    const row = submission(original.firstMessage!.clientMessageId)
    await act(async () => {
      settleStructuredAgentSessionSendsFromJournal(launch.sessionId, [submission('unrelated')], [])
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    if (cancel) {
      await act(async () => {
        cancelStructuredAgentLaunch('workspace-1', launch.sessionId)
      })
    }
    await act(async () => {
      if (proof === 'receipt') {
        const success = created(original)
        first.resolve({
          ...success,
          value: {
            ...success.value,
            firstMessage: row,
            page: { ...success.value.page, submissions: [submission('unrelated')] }
          }
        })
      } else {
        // A superseded refusal cannot hand back the held opening.
        first.resolve(refusal)
        await vi.advanceTimersByTimeAsync(0)
        expect(draft(launch.sessionId)).toBe('newer draft')
        settleStructuredAgentSessionSendsFromJournal(launch.sessionId, [row], [])
      }
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      cancel ? 'cancelled' : 'published'
    )
    expect(draft(launch.sessionId)).toBe('newer draft')
    if (!cancel) {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
    }
  }
)

it('persists refusal-time custody across reload and offers Retry without handing the opening back', async () => {
  mocks.call.mockRejectedValue(new Error('answer lost'))
  const launch = start()
  await expect(launch.launchResult).rejects.toThrow()
  await launch.promptDeliveryResult
  const original = createParams()
  mocks.admit.mockResolvedValue({ kind: 'declined', reason: 'remote' })
  retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)
  await getStructuredLaunchStateBySessionId(launch.sessionId)?.promise.catch(() => {})
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  render(<LaunchNotice sessionId={launch.sessionId} />)
  expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toMatchObject([
    { clientMessageId: original.firstMessage!.clientMessageId, phase: 'unconfirmed' }
  ])
  mocks.admit.mockResolvedValue({ kind: 'admitted' })
  mocks.call.mockImplementation(async (_target, _method, params) =>
    created(CreateIntentParams.parse(params))
  )
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
  })
  expect(draft(launch.sessionId)).toBe('')
})

it('keeps empty-create uncertainty separate from current opening-refusal guidance', async () => {
  mocks.call.mockResolvedValue({
    ok: false,
    refusal: {
      code: 'agent_session_conflict',
      details: { reason: 'sessionExists' }
    }
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local'
  })
  await expect(launch.launchResult).rejects.toThrow()
  expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
    'visibility-unknown'
  )
  expect(getStructuredAgentSessionLaunchFailure('workspace-1', launch.sessionId)).toBeNull()
})

it('coalesces re-delivery of an uncertain action before, during and after its requested Retry', async () => {
  mocks.call.mockReturnValue(new Promise(() => {}))
  const options = {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local' as const,
    prompt: 'opening text'
  }
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', options)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  const original = createParams()
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(launch.launchResult).rejects.toThrow('Opening message outcome unknown.')
  const joined = startStructuredAgentLaunch('workspace-1', 'codex', options)
  expect(joined.sessionId).toBe(launch.sessionId)
  await expect(joined.launchResult).rejects.toThrow('Opening message outcome unknown.')
  expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toHaveLength(1)
  expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
    original.firstMessage
  )
  expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  const retry = deferred<unknown>()
  mocks.call.mockImplementation((_target, method) =>
    method === 'agentSession.create' ? retry.promise : Promise.reject(new Error('no record'))
  )
  expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
  await vi.waitFor(() =>
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(2)
  )
  const during = startStructuredAgentLaunch('workspace-1', 'codex', options)
  expect(during.sessionId).toBe(launch.sessionId)
  expect(during.joined).toBe(true)
  retry.resolve({
    ok: false,
    refusal: { code: 'structured_agent_session_unsupported' }
  })
  await getStructuredLaunchStateBySessionId(launch.sessionId)?.promise.catch(() => {})
  const after = startStructuredAgentLaunch('workspace-1', 'codex', options)
  expect(after.sessionId).toBe(launch.sessionId)
  expect(after.joined).toBe(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(
    mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
  ).toHaveLength(2)
  expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toMatchObject([
    { clientMessageId: original.firstMessage!.clientMessageId, phase: 'unconfirmed' }
  ])
})
