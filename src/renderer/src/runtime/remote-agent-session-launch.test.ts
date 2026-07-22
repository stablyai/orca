import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  supportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code: string
    constructor(response: { error: { code: string; message: string } }) {
      super(response.error.message)
      this.code = response.error.code
    }
  },
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import { RuntimeRpcCallError } from './runtime-rpc-client'
import { runRemoteAgentSessionLaunch } from './remote-agent-session-launch'

describe('remote agent-session launch routing', () => {
  beforeEach(() => {
    mocks.supportsCapability.mockReset()
  })

  it('uses host authority only when the host advertises it', async () => {
    const hostAuthority = vi.fn().mockResolvedValue('structured')
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockResolvedValue(true)

    await expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority, legacy })
    ).resolves.toBe('structured')
    expect(hostAuthority).toHaveBeenCalledOnce()
    expect(legacy).not.toHaveBeenCalled()
  })

  it('preserves the exact legacy path when the capability is absent', async () => {
    const hostAuthority = vi.fn().mockResolvedValue('structured')
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority, legacy })
    ).resolves.toBe('legacy')
    expect(legacy).toHaveBeenCalledOnce()
    expect(hostAuthority).not.toHaveBeenCalled()
  })

  it('keeps legacy behavior when a read-only capability probe fails', async () => {
    const hostAuthority = vi.fn().mockResolvedValue('structured')
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockRejectedValue(new Error('status temporarily unavailable'))

    await expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority, legacy })
    ).resolves.toBe('legacy')
    expect(legacy).toHaveBeenCalledOnce()
    expect(hostAuthority).not.toHaveBeenCalled()
  })

  it('does not bypass an incompatible runtime protocol', async () => {
    const compatibilityError = Object.assign(new Error('runtime incompatible'), {
      code: 'runtime_compat_block'
    })
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockRejectedValue(compatibilityError)

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn(),
        legacy
      })
    ).rejects.toBe(compatibilityError)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('never downgrades after structured dispatch has started', async () => {
    const structuredError = new Error('structured response was lost')
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockResolvedValue(true)

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(structuredError),
        legacy
      })
    ).rejects.toBe(structuredError)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('uses legacy only for the host pre-side-effect lower-owner response', async () => {
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockResolvedValue(true)
    const legacyRequired = new RuntimeRpcCallError({
      id: 'request-1',
      ok: false,
      error: { code: 'agent_session_legacy_required', message: 'legacy required' }
    })

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(legacyRequired),
        legacy
      })
    ).resolves.toBe('legacy')
    expect(legacy).toHaveBeenCalledOnce()
  })

  it('uses legacy when a replaced old host does not recognize the structured method', async () => {
    const legacy = vi.fn().mockResolvedValue('legacy')
    mocks.supportsCapability.mockResolvedValue(true)
    const methodNotFound = new RuntimeRpcCallError({
      id: 'request-1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(methodNotFound),
        legacy
      })
    ).resolves.toBe('legacy')
    expect(legacy).toHaveBeenCalledOnce()
  })

  it('uses legacy directly when no structured form exists', async () => {
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(runRemoteAgentSessionLaunch({ environmentId: 'env-1', legacy })).resolves.toBe(
      'legacy'
    )
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
  })
})
