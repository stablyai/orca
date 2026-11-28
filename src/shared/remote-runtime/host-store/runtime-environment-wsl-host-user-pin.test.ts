import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addWslHostEnvironment,
  findWslHostDeployment,
  refreshWslHostPairing
} from './runtime-environment-wsl-host-operations'

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:41000',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'device-token',
  pairedDeviceId: 'paired-client'
})
const ports = { localPort: 41000, remotePort: 6768 }

// #49180: the account a WSL host runs as is pinned once and never follows a default-user change.
describe('WSL host Linux user pin in the deployment record', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-user-pin-'))
  })
  afterEach(async () => await removeTempDirs([userDataPath]))

  it('pins a record from before pinning on its next verified connect, then never moves it', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode,
      record: { kind: 'wsl', distro: 'Ubuntu', ...ports }
    })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.linuxUser).toBeUndefined()
    refreshWslHostPairing(userDataPath, 'wsl:ubuntu', { pairingCode, ...ports, linuxUser: '-x' })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.linuxUser).toBeUndefined()
    refreshWslHostPairing(userDataPath, 'wsl:ubuntu', { pairingCode, ...ports, linuxUser: 'root' })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.linuxUser).toBe('root')
    refreshWslHostPairing(userDataPath, 'wsl:ubuntu', { pairingCode, ...ports, linuxUser: 'alice' })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.linuxUser).toBe('root')
  })
})
