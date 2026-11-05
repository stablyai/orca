// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  createParams,
  created
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { readStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import { retryStructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

let restore: (() => void) | undefined
beforeEach(() => {
  restore = resetCreateMessageFixture()
})
afterEach(() => cleanupCreateMessageFixture(restore))

const forkFrom = { sessionId: 'codex_source', throughItemId: 'item-reply-2' }

it('keeps the fork source through create, the saved launch, reload and retry, without new-chat options', async () => {
  mocks.exactSupport.mockImplementation(
    async (_target, capability) => capability === 'agentSession.create.fork.v1'
  )
  const pending = deferred<unknown>()
  mocks.call.mockReturnValue(pending.promise)
  const launch = startStructuredAgentLaunch('workspace-fork', 'codex', {
    requestId: 'fork-action',
    executionHostId: 'local',
    forkFrom,
    activate: true,
    launchOptions: { model: 'unrelated-default', effort: 'low' }
  })
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  const params = createParams()
  expect(params.forkFrom).toEqual(forkFrom)
  expect(params.options).toBeUndefined()
  expect(params.optionsMode).toBeUndefined()
  expect(readStructuredAgentLaunchRecord(launch.sessionId)?.forkFrom).toEqual(forkFrom)
  const restored = restorePersistedStructuredLaunchState('workspace-fork', launch.sessionId)
  expect(restored?.intent.params).toEqual(params)
  expect(retryStructuredAgentSessionLaunchIntent(restored!.intent).params.forkFrom).toEqual(
    forkFrom
  )
  pending.resolve(created())
  await launch.launchResult
})

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
