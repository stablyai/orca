import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ probe: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code: string
    constructor(response: { error: { code: string; message: string } }) {
      super(response.error.message)
      this.code = response.error.code
    }
  },
  probeLiveRuntimeEnvironmentCapabilities: mocks.probe
}))

import { RuntimeRpcCallError } from './runtime-rpc-client'
import { runRemoteAgentSessionLaunch } from './remote-agent-session-launch'

const authority = {
  runtimeId: 'runtime-1',
  expectedEnvironmentPairingRevision: 7,
  capabilities: [
    'terminal.attribution-removed.v1',
    'agent-session.host-authority.v1',
    'agent-session.omp-resume-path.v1'
  ]
} as const

describe('remote agent-session launch routing', () => {
  beforeEach(() => {
    mocks.probe.mockReset()
    mocks.probe.mockResolvedValue({ supported: true, authority })
  })

  it('uses one live all-capability probe before host authority', async () => {
    const hostAuthority = vi.fn().mockResolvedValue('structured')
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        expectedEnvironmentPairingRevision: 7,
        hostAuthority,
        requiredHostAuthorityCapabilities: ['agent-session.omp-resume-path.v1'],
        legacy
      })
    ).resolves.toBe('structured')

    expect(mocks.probe).toHaveBeenCalledWith({
      environmentId: 'env-1',
      requiredCapabilities: [
        'terminal.attribution-removed.v1',
        'agent-session.host-authority.v1',
        'agent-session.omp-resume-path.v1'
      ],
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: 7
    })
    expect(hostAuthority).toHaveBeenCalledWith(authority)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('uses fenced legacy when a structured-only capability is absent', async () => {
    mocks.probe.mockResolvedValue({ supported: false, authority })
    const hostAuthority = vi.fn().mockResolvedValue('structured')
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority,
        requiredHostAuthorityCapabilities: ['agent-session.omp-resume-path.v1'],
        legacy
      })
    ).resolves.toBe('legacy')

    expect(hostAuthority).not.toHaveBeenCalled()
    expect(legacy).toHaveBeenCalledWith({ skipCompatibilityCheck: true, authority })
  })

  it('fails closed without attribution-removal capability evidence', async () => {
    mocks.probe.mockResolvedValue({
      supported: false,
      authority: { ...authority, capabilities: ['agent-session.host-authority.v1'] }
    })
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority: vi.fn(), legacy })
    ).rejects.toThrow('Update the host and try again')
    expect(legacy).not.toHaveBeenCalled()
  })

  it('fails closed when the live capability probe fails', async () => {
    mocks.probe.mockRejectedValue(
      Object.assign(new Error('status temporarily unavailable'), { code: 'runtime_timeout' })
    )
    const legacy = vi.fn().mockResolvedValue('legacy')

    const result = expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority: vi.fn(), legacy })
    ).rejects
    await result.toThrow('Update the host and try again')
    await result.toMatchObject({ code: 'runtime_timeout' })
    expect(legacy).not.toHaveBeenCalled()
  })

  it('preserves an incompatible runtime protocol error', async () => {
    const compatibilityError = Object.assign(new Error('runtime incompatible'), {
      code: 'runtime_compat_block'
    })
    mocks.probe.mockRejectedValue(compatibilityError)
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({ environmentId: 'env-1', hostAuthority: vi.fn(), legacy })
    ).rejects.toBe(compatibilityError)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('never downgrades after structured dispatch has started', async () => {
    const structuredError = new Error('structured response was lost')
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(structuredError),
        legacy
      })
    ).rejects.toBe(structuredError)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('uses fenced legacy for the pre-side-effect lower-owner response', async () => {
    const legacyRequired = new RuntimeRpcCallError({
      id: 'request-1',
      ok: false,
      error: { code: 'agent_session_legacy_required', message: 'legacy required' }
    })
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(legacyRequired),
        legacy
      })
    ).resolves.toBe('legacy')
    expect(legacy).toHaveBeenCalledWith({ skipCompatibilityCheck: true, authority })
  })

  it('does not downgrade when a replacement host rejects the structured method', async () => {
    const methodNotFound = new RuntimeRpcCallError({
      id: 'request-1',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' }
    })
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(
      runRemoteAgentSessionLaunch({
        environmentId: 'env-1',
        hostAuthority: vi.fn().mockRejectedValue(methodNotFound),
        legacy
      })
    ).rejects.toBe(methodNotFound)
    expect(legacy).not.toHaveBeenCalled()
  })

  it('probes and fences legacy when no structured form exists', async () => {
    const legacy = vi.fn().mockResolvedValue('legacy')

    await expect(runRemoteAgentSessionLaunch({ environmentId: 'env-1', legacy })).resolves.toBe(
      'legacy'
    )
    expect(legacy).toHaveBeenCalledWith({ skipCompatibilityCheck: true, authority })
  })
})
