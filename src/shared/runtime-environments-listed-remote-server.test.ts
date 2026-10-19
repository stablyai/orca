import { describe, expect, it } from 'vitest'
import { isListedRemoteServer, isWslHostRuntimeEnvironment } from './runtime-environments'

const wslHost = {
  name: 'Remote box',
  orcadDeployment: {
    kind: 'wsl' as const,
    distro: 'Ubuntu',
    localPort: 42000,
    remotePort: 6768
  }
}

describe('the generic remote-server list', () => {
  it('leaves out WSL hosts by their record kind, whatever they are named', () => {
    expect(isWslHostRuntimeEnvironment(wslHost)).toBe(true)
    expect(isListedRemoteServer(wslHost)).toBe(false)
  })

  it('leaves out recipe VMs and keeps paired and SSH-managed servers', () => {
    expect(isListedRemoteServer({ source: 'ephemeral-vm' })).toBe(false)
    expect(isListedRemoteServer({})).toBe(true)
    expect(
      isListedRemoteServer({
        orcadDeployment: {
          sshTargetId: 'box',
          sshTargetGeneration: 1,
          localPort: 41000,
          remotePort: 6768
        }
      })
    ).toBe(true)
  })
})
