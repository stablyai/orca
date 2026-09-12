import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('./structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { closeStructuredAgentSession } from './structured-agent-session-close'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.call.mockResolvedValue({ ok: true })
  mocks.supportsCapability.mockResolvedValue(true)
})

describe('closeStructuredAgentSession', () => {
  it('closes a local session without a redundant capability probe', async () => {
    await expect(closeStructuredAgentSession({ kind: 'local' }, 'codex-session-1')).resolves.toBe(
      'closed'
    )

    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.close', {
      sessionId: 'codex-session-1'
    })
  })

  it('closes through a paired host that advertises the structured session surface', async () => {
    const target = { kind: 'environment', environmentId: 'env-1' } as const

    await expect(closeStructuredAgentSession(target, 'claude-session-1')).resolves.toBe('closed')

    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.close', {
      sessionId: 'claude-session-1'
    })
  })

  it('does not send an unknown method to a legacy paired host', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(
      closeStructuredAgentSession(
        { kind: 'environment', environmentId: 'legacy-env' },
        'codex-session-1'
      )
    ).resolves.toBe('unsupported')

    expect(mocks.call).not.toHaveBeenCalled()
  })
})
