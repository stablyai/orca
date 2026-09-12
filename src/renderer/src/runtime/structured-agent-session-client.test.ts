// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  call: vi.fn(),
  supportsCapability: vi.fn()
}))

vi.mock('./runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 7,
  captureRuntimeEnvironmentRequestRevision: (_environmentId: string, expected?: number) =>
    expected ?? 7
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import {
  callStructuredAgentSession,
  structuredAgentSessionSupportsPromptCancel,
  subscribeStructuredAgentSession
} from './structured-agent-session-client'

describe('structuredAgentSessionSupportsPromptCancel', () => {
  beforeEach(() => vi.resetAllMocks())

  it('uses the bundled host locally and capability-gates remote hosts', async () => {
    mocks.call.mockResolvedValue({ capabilities: [] })

    await expect(structuredAgentSessionSupportsPromptCancel({ kind: 'local' })).resolves.toBe(true)
    await expect(
      structuredAgentSessionSupportsPromptCancel({
        kind: 'environment',
        environmentId: 'env-1'
      })
    ).resolves.toBe(false)
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      { timeoutMs: 15_000, expectedEnvironmentPairingRevision: 7 }
    )
  })

  it('recognizes prompt cancellation on the captured pairing revision', async () => {
    mocks.call.mockResolvedValue({
      capabilities: [AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY]
    })

    await expect(
      structuredAgentSessionSupportsPromptCancel({ kind: 'environment', environmentId: 'env-1' }, 7)
    ).resolves.toBe(true)
    expect(mocks.call).toHaveBeenCalledWith(
      expect.anything(),
      'status.get',
      undefined,
      expect.objectContaining({ expectedEnvironmentPairingRevision: 7 })
    )
  })

  it('fails closed when remote capability status is unavailable', async () => {
    mocks.call.mockRejectedValue(new Error('Host unreachable'))

    await expect(
      structuredAgentSessionSupportsPromptCancel({
        kind: 'environment',
        environmentId: 'env-1'
      })
    ).rejects.toThrow('Host unreachable')
  })
})

describe('callStructuredAgentSession rewind capability', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const
  const params = { itemId: 'item-1', expectedEpoch: 'epoch-1' }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.call.mockResolvedValue({ ok: true })
    mocks.supportsCapability.mockResolvedValue(true)
  })

  it('refuses an older host before dispatching rewind', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(callStructuredAgentSession(target, 'agentSession.rewind', params)).rejects.toThrow(
      'Rewinding requires a newer Orca server'
    )
    expect(mocks.supportsCapability).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('dispatches rewind once the host advertises the method', async () => {
    await expect(
      callStructuredAgentSession(target, 'agentSession.rewind', params)
    ).resolves.toEqual({
      ok: true
    })
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    )
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(target, 'agentSession.rewind', params)
  })

  it('does not dispatch rewind when host capability cannot be verified', async () => {
    mocks.supportsCapability.mockRejectedValue(new Error('Host unreachable'))

    await expect(callStructuredAgentSession(target, 'agentSession.rewind', params)).rejects.toThrow(
      'Host unreachable'
    )
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('uses the local build directly and leaves existing remote methods available', async () => {
    await callStructuredAgentSession({ kind: 'local' }, 'agentSession.rewind', params)
    await callStructuredAgentSession(target, 'agentSession.send', params)

    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.rewind', params)
    expect(mocks.call).toHaveBeenCalledWith(target, 'agentSession.send', params)
  })
})

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
