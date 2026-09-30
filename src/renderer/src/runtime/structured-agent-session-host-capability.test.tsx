// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ supports: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { useStructuredAgentSessionHostStopsConversation } from './structured-agent-session-host-capability'

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
