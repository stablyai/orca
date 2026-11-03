// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../shared/agent-session/lifecycle/agent-session-stop-capabilities'

const mocks = vi.hoisted(() => ({
  supports: vi.fn(),
  regenerate: vi.fn(async () => true),
  contactRegained: new Map<string, () => void>()
}))

vi.mock('./structured-agent-session-client', () => ({
  regenerateStructuredAgentSessionName: mocks.regenerate
}))
vi.mock('./structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => null
}))
import { useNativeChatNamingFailure } from '../components/tab-bar/use-native-chat-naming-failure'

vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: mocks.supports }))

vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    mocks.contactRegained.set(environmentId, listener)
    return () => mocks.contactRegained.delete(environmentId)
  }
}))

import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { useStructuredAgentSessionHostQueuesMessagesState } from './structured-agent-session-host-capability'

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
  vi.clearAllMocks()
})

describe('the queued-messages capability, three-state', () => {
  it('reads a failed remote probe as unknown, and asks again once contact is regained', async () => {
    mocks.supports.mockRejectedValueOnce(new Error('unreachable'))
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostQueuesMessagesState({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() => expect(mocks.supports).toHaveBeenCalledTimes(1))
    expect(result.current).toBe('unknown')

    mocks.supports.mockResolvedValueOnce(true)
    act(() => {
      mocks.contactRegained.get('env-1')?.()
    })
    await waitFor(() => expect(result.current).toBe('supported'))
    expect(mocks.supports).toHaveBeenLastCalledWith(
      'env-1',
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    )
  })

  it('restores the naming action after a failed capability probe without calling an unsupported host', async () => {
    mocks.supports.mockRejectedValueOnce(new Error('unreachable'))
    const { result } = renderHook(() =>
      useNativeChatNamingFailure({
        executionHostId: 'runtime:env-1',
        sessionId: 'chat',
        error: { message: 'Failed', failedAt: 1 }
      })
    )
    await waitFor(() => expect(mocks.supports).toHaveBeenCalledTimes(1))
    act(() => result.current?.regenerate())
    expect(mocks.regenerate).not.toHaveBeenCalled()
    mocks.supports.mockResolvedValueOnce(true)
    act(() => mocks.contactRegained.get('env-1')?.())
    await waitFor(() => expect(result.current?.canRegenerate).toBe(true))
    act(() => result.current?.regenerate())
    expect(mocks.regenerate).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'chat'
    )
    expect(result.current?.regenerating).toBe(false)
  })
})
