import { describe, expect, it } from 'vitest'
import { runtimePairingRepairRoute } from './runtime-environments'

const wslHost = {
  name: 'Remote box',
  orcadDeployment: {
    kind: 'wsl' as const,
    distro: 'Ubuntu',
    localPort: 42000,
    remotePort: 6768
  }
}

describe('who pairs a server that refused this desktop', () => {
  it('is SSH only for a server Orca manages over SSH, never WSL or a cloud VM', () => {
    expect(
      runtimePairingRepairRoute({
        orcadDeployment: {
          sshTargetId: 'box',
          sshTargetGeneration: 1,
          localPort: 41000,
          remotePort: 6768
        }
      })
    ).toBe('ssh')
    expect(runtimePairingRepairRoute(wslHost)).toBe('connect')
    expect(runtimePairingRepairRoute({ source: 'ephemeral-vm' })).toBe('connect')
    expect(runtimePairingRepairRoute({})).toBe('access-link')
  })
})
