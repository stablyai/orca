// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn()
}))

vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 7
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

import { subscribeStructuredAgentSession } from './structured-agent-session-client'

describe('subscribeStructuredAgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
    Object.assign(window, {
      api: {
        runtimeEnvironments: { subscribe: mocks.subscribe }
      }
    })
  })

  it('forwards graceful remote closes to the reconnect owner', async () => {
    const onClose = vi.fn()

    await subscribeStructuredAgentSession(
      { kind: 'environment', environmentId: 'env-1' },
      { sessionId: 'session-1' },
      vi.fn(),
      vi.fn(),
      onClose
    )

    const callbacks = mocks.subscribe.mock.calls[0]?.[1] as { onClose?: () => void }
    expect(callbacks.onClose).toBe(onClose)
    callbacks.onClose?.()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
