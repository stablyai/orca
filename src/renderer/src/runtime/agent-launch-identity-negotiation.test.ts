import { describe, expect, it, vi } from 'vitest'
import { RUNTIME_COMPAT_BLOCK_CODE } from './runtime-protocol-compat'
import {
  AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE,
  negotiateAgentLaunchIdentityArm
} from './agent-launch-identity-negotiation'

const mocks = vi.hoisted(() => ({ supportsCapability: vi.fn() }))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

function compatBlockError(): Error {
  const error = new Error('Update Orca on the server.')
  ;(error as { code?: string }).code = RUNTIME_COMPAT_BLOCK_CODE
  return error
}

describe('negotiateAgentLaunchIdentityArm', () => {
  it('sends the identity arm to a capable runtime', async () => {
    mocks.supportsCapability.mockResolvedValueOnce(true)
    await expect(negotiateAgentLaunchIdentityArm('env-1', false)).resolves.toBe('identity')
    expect(mocks.supportsCapability).toHaveBeenCalledWith('env-1', 'agent-launch.identity.v1')
  })

  // A pre-identity host strips the arm and spawns a bare login shell it still
  // answers as a created terminal, so callers with nothing to degrade to must fail.
  it('refuses when the runtime is unsupported and no client command exists', async () => {
    mocks.supportsCapability.mockResolvedValueOnce(false)
    await expect(negotiateAgentLaunchIdentityArm('env-1', false)).rejects.toThrow(
      AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE
    )
  })

  it('degrades to the legacy command when the runtime is unsupported', async () => {
    mocks.supportsCapability.mockResolvedValueOnce(false)
    await expect(negotiateAgentLaunchIdentityArm('env-1', true)).resolves.toBe('legacy')
  })

  it('degrades to the legacy command when the probe fails transiently', async () => {
    mocks.supportsCapability.mockRejectedValueOnce(new Error('offline'))
    await expect(negotiateAgentLaunchIdentityArm('env-1', true)).resolves.toBe('legacy')
  })

  it('rethrows a transient probe failure when there is no command to degrade to', async () => {
    mocks.supportsCapability.mockRejectedValueOnce(new Error('offline'))
    await expect(negotiateAgentLaunchIdentityArm('env-1', false)).rejects.toThrow('offline')
  })

  it('keeps a version block a version block even with a legacy command', async () => {
    mocks.supportsCapability.mockRejectedValueOnce(compatBlockError())
    await expect(negotiateAgentLaunchIdentityArm('env-1', true)).rejects.toMatchObject({
      code: RUNTIME_COMPAT_BLOCK_CODE
    })
  })
})
