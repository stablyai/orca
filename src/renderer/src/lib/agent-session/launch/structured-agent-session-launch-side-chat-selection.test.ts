// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  created,
  createParams
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'

it('does not seed a side chat from unrelated new-chat defaults on exact-selection hosts', async () => {
  const restore = resetCreateMessageFixture()
  try {
    mocks.exactSupport.mockResolvedValue(true)
    mocks.settings = { nativeChatSessionOptions: { codex: { model: 'different-default' } } }
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      sideChatOf: 'codex_parent',
      prompt: 'a side question',
      launchOptions: { permissionMode: 'read-only' }
    })
    await launch.launchResult
    const params = createParams()
    expect(params.sideChatOf).toBe('codex_parent')
    expect(params.options).toEqual({ permissionMode: 'read-only' })
    expect(params.firstMessage?.selection).toEqual({})
  } finally {
    mocks.settings = {}
    cleanupCreateMessageFixture(restore)
  }
})
