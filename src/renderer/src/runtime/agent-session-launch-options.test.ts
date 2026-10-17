import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_ENV_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { createAgentSessionLaunchOptions } from './agent-session-launch-options'

const mocks = vi.hoisted(() => ({
  supportsCapability: vi.fn(),
  resolveSshHostProxyEnvForTarget: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('../lib/ssh-host-proxy-env', () => ({
  resolveSshHostProxyEnvForTarget: mocks.resolveSshHostProxyEnvForTarget
}))

const proxyEnv = {
  HTTP_PROXY: 'http://host:3128',
  HTTPS_PROXY: 'http://host:3128',
  NO_PROXY: 'localhost'
}

describe('createAgentSessionLaunchOptions', () => {
  beforeEach(() => {
    mocks.supportsCapability.mockReset()
    mocks.resolveSshHostProxyEnvForTarget.mockReset()
    mocks.resolveSshHostProxyEnvForTarget.mockResolvedValue(proxyEnv)
    mocks.supportsCapability.mockImplementation(
      async (_environmentId: string, capability: string) =>
        capability === AGENT_SESSION_CREATE_ENV_RUNTIME_CAPABILITY ||
        capability === AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
    )
  })

  it('appends the host proxy env to the negotiated keyboard field', async () => {
    const options = createAgentSessionLaunchOptions(true, 'target-1')

    await expect(options('env-1')).resolves.toEqual({
      terminalKittyKeyboardProtocol: true,
      env: proxyEnv
    })
    expect(mocks.resolveSshHostProxyEnvForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'target-1' })
    )
  })

  it('omits the env when the host does not advertise the field', async () => {
    mocks.supportsCapability.mockImplementation(async () => false)
    const options = createAgentSessionLaunchOptions(true, 'target-1')

    await expect(options('env-1')).resolves.toEqual({})
  })

  it('looks nothing up for an execution host that is no SSH target of this client', async () => {
    const options = createAgentSessionLaunchOptions(undefined, null)

    await expect(options('env-1')).resolves.toEqual({})
    expect(mocks.resolveSshHostProxyEnvForTarget).not.toHaveBeenCalled()
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
  })

  it('never probes capability for a host without a proxy of its own', async () => {
    mocks.resolveSshHostProxyEnvForTarget.mockResolvedValue({})
    const options = createAgentSessionLaunchOptions(undefined, 'target-1')

    await expect(options('env-1')).resolves.toEqual({})
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
  })

  it('launches without the env when the proxy lookup itself fails', async () => {
    mocks.resolveSshHostProxyEnvForTarget.mockRejectedValue(new Error('no targets'))
    const options = createAgentSessionLaunchOptions(undefined, 'target-1')

    await expect(options('env-1')).resolves.toEqual({})
  })

  it('freezes one payload per environment so a retry replays it', async () => {
    const options = createAgentSessionLaunchOptions(true, 'target-1')

    const first = await options('env-1')
    mocks.resolveSshHostProxyEnvForTarget.mockResolvedValue({ HTTP_PROXY: 'http://edited:1' })

    await expect(options('env-1')).resolves.toEqual(first)
    expect(mocks.resolveSshHostProxyEnvForTarget).toHaveBeenCalledTimes(1)
  })
})
