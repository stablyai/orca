// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
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
