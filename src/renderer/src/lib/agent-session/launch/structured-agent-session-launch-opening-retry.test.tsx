// @vitest-environment happy-dom
import { newAgentLaunchRequestId } from './routing/agent-launch-request-id'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  createParams,
  created,
  start,
  draft,
  deferred
} from './structured-agent-session-launch-create-message.test-fixture'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'
import {
  getStructuredLaunchStateBySessionId,
  getStructuredAgentSessionLaunchLifecycle,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import { recheckUnconfirmedStructuredAgentLaunches } from './structured-agent-session-launch-unconfirmed-recheck'
import { markStructuredAgentSessionLaunchPublished } from './structured-agent-session-launch-publication'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/host-access/use-native-chat-provisional-launch'
import { structuredSessionNotices } from '../../../components/native-chat/messages/notices/native-chat-structured-session-notices'
import { NativeChatComposerNotices } from '@/components/native-chat/composer/controls/NativeChatComposerNotices'

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
