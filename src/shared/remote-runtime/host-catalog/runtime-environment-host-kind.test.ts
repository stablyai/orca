import { describe, expect, it } from 'vitest'
import { classifyRuntimeEnvironmentHost } from './runtime-environment-host-kind'

const tunnel = { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
const wsl = { kind: 'wsl' as const, distro: 'Ubuntu', localPort: 1, remotePort: 2 }

describe('classifyRuntimeEnvironmentHost', () => {
  it.each([
    ['no deployment', {}],
    ['a null deployment', { orcadDeployment: null }],
    ['an SSH link saved without its kind', { orcadDeployment: tunnel }],
    ['an SSH link', { orcadDeployment: { kind: 'ssh' as const, ...tunnel } }]
  ])('treats %s as a network host', (_name, environment) => {
    expect(classifyRuntimeEnvironmentHost(environment)).toEqual({ kind: 'network', environment })
  })

  it('treats a WSL deployment as a WSL host and hands back its link', () => {
    const environment = { orcadDeployment: wsl }
    const host = classifyRuntimeEnvironmentHost(environment)
    expect(host).toEqual({ kind: 'wsl', environment, deployment: wsl })
    expect(host.environment).toBe(environment)
  })
})
