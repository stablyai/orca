// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
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

it('opens independent concurrent side questions with their own permission picks', async () => {
  const restore = resetCreateMessageFixture()
  const release = Promise.withResolvers<void>()
  try {
    mocks.exactSupport.mockResolvedValue(true)
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method !== 'agentSession.create') {
        throw new Error(`Unexpected RPC ${method}`)
      }
      await release.promise
      return created(params as Parameters<typeof created>[0])
    })
    const open = (prompt: string, launchOptions?: Record<string, string>) =>
      startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        sideChatOf: 'codex_parent',
        prompt,
        launchOptions
      })
    const first = open('Investigate the failure', { permissionMode: 'read-only' })
    const second = open('Implement the change')
    expect(second.sessionId).not.toBe(first.sessionId)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    expect(mocks.call.mock.calls.map(([, , params]) => params)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          options: { permissionMode: 'read-only' },
          firstMessage: expect.objectContaining({
            body: expect.objectContaining({
              blocks: [{ type: 'text', text: 'Investigate the failure' }]
            })
          })
        }),
        expect.not.objectContaining({ options: { permissionMode: 'read-only' } })
      ])
    )
    release.resolve()
    await Promise.all([first.launchResult, second.launchResult])
  } finally {
    release.resolve()
    cleanupCreateMessageFixture(restore)
  }
})
