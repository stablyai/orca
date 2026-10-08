// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY
} from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  supports: vi.fn(),
  contactRegained: new Map<string, () => void>()
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    mocks.contactRegained.set(environmentId, listener)
    return () => mocks.contactRegained.delete(environmentId)
  }
}))

import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import {
  useStructuredAgentSessionHostQueuesMessagesState,
  useStructuredAgentSessionHostRecoversRewindOnSend,
  useStructuredAgentSessionHostStopsConversation
} from './structured-agent-session-host-capability'

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
  vi.clearAllMocks()
})

describe('whether a host takes a Stop naming no turn', () => {
  it('reads it from the host capability of that name, not from accepting sends first', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostStopsConversation({ kind: 'local' })).result
        .current
    ).toBe(false)

    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostStopsConversation({ kind: 'local' })).result
        .current
    ).toBe(true)
  })

  it('asks a remote host for that capability', async () => {
    mocks.supports.mockResolvedValueOnce(true)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostStopsConversation({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() => expect(result.current).toBe(true))
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
    )
  })
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

  it('reads a local runtime that has not answered as unknown', () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostQueuesMessagesState({ kind: 'local' })
    )
    expect(result.current).toBe('unknown')
  })
})

describe('whether a host settles an in-doubt rewind on the next send', () => {
  it('reads the local runtime, which only rewinding is not enough for', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_REWIND_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostRecoversRewindOnSend({ kind: 'local' })).result
        .current
    ).toBe(false)
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_REWIND_RECOVERY_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostRecoversRewindOnSend({ kind: 'local' })).result
        .current
    ).toBe(true)
  })

  it.each([true, false])('asks a remote host, which answers %s', async (supported) => {
    mocks.supports.mockResolvedValueOnce(supported)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostRecoversRewindOnSend({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() =>
      expect(mocks.supports).toHaveBeenCalledWith('env-1', AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
    )
    await waitFor(() => expect(result.current).toBe(supported))
  })
})
