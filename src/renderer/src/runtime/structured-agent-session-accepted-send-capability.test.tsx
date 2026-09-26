// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({ supports: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import { useStructuredAgentSessionHostAcceptsSend } from './structured-agent-session-accepted-send-capability'

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
  vi.clearAllMocks()
})

describe('whether a host accepts a send before any agent has it', () => {
  it('reads the local host from its advertised capabilities', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
    const { result } = renderHook(() => useStructuredAgentSessionHostAcceptsSend({ kind: 'local' }))
    expect(result.current).toBe(true)
  })

  it('treats a local host that does not advertise it as an older one', () => {
    setLocalRuntimeCapabilitiesForTests([])
    const { result } = renderHook(() => useStructuredAgentSessionHostAcceptsSend({ kind: 'local' }))
    expect(result.current).toBe(false)
  })

  it('asks a remote host, and reads a failed probe as an older host', async () => {
    mocks.supports.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('offline'))
    const accepts = renderHook(() =>
      useStructuredAgentSessionHostAcceptsSend({ kind: 'environment', environmentId: 'env-1' })
    )
    await waitFor(() => expect(accepts.result.current).toBe(true))
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY
    )

    const offline = renderHook(() =>
      useStructuredAgentSessionHostAcceptsSend({ kind: 'environment', environmentId: 'env-2' })
    )
    await waitFor(() => expect(mocks.supports).toHaveBeenCalledTimes(2))
    expect(offline.result.current).toBe(false)
  })
})
