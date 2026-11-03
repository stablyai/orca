import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'

const mocks = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  structuredAgentSessionHostSupports: mocks.supports
}))
import { launchCustomAgentChat } from './launch-custom-agent-chat'

beforeEach(() => {
  mocks.call.mockReset()
  mocks.supports.mockResolvedValue(true)
})

const input = {
  worktreeId: 'folder-1',
  agent: 'custom-reviewer',
  executionHostId: 'runtime:remote-1',
  groupId: 'group-1'
} as const

describe('starting a host-registered custom chat', () => {
  it('uses the execution host, a valid durable create envelope and explicit Ask mode', async () => {
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.createSupport') {
        return { supported: true }
      }
      expect(CreateIntentParams.safeParse(params).success).toBe(true)
      expect(params).toMatchObject({
        agent: input.agent,
        options: { permissionMode: 'ask' },
        tabPlacement: { groupId: 'group-1' }
      })
      expect(params).not.toHaveProperty('accountHome')
      return { ok: true, value: { sessionId: params.envelope.sessionId } }
    })
    expect(await launchCustomAgentChat(input)).toMatch(/^custom-reviewer_/)
    expect(
      mocks.call.mock.calls.every(
        ([target]) => target.kind === 'environment' && target.environmentId === 'remote-1'
      )
    ).toBe(true)
  })

  it('does not create on an unsupported host or automatically retry a lost create reply', async () => {
    mocks.call.mockResolvedValueOnce({ supported: false })
    await expect(launchCustomAgentChat(input)).rejects.toThrow('cannot open')
    expect(mocks.call).toHaveBeenCalledTimes(1)
    mocks.call.mockReset()
    mocks.call
      .mockResolvedValueOnce({ supported: true })
      .mockRejectedValueOnce(new Error('connection lost'))
    await expect(launchCustomAgentChat(input)).rejects.toThrow('connection lost')
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(1)
  })
})
