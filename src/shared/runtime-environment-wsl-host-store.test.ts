import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import { listEnvironments } from './runtime-environment-store'
import {
  addWslHostEnvironment,
  findWslHostDeployment,
  refreshWslHostPairing,
  removeWslHostEnvironment
} from './runtime-environment-wsl-host-store'
import { getPreferredPairingOffer } from './runtime-environments'
import { writeWslHostDeployment } from './wsl-host-deployment-store'

const publicKeyB64 = Buffer.alloc(32, 7).toString('base64')

function code(port: number, deviceToken = 'token-1'): string {
  return encodePairingOffer({
    v: 2,
    endpoint: `ws://127.0.0.1:${port}`,
    deviceToken,
    publicKeyB64
  })
}

const record = {
  kind: 'wsl' as const,
  distro: 'Ubuntu',
  distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
  localPort: 42000,
  remotePort: 6768
}

describe('WSL host environment store', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-store-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers a paired environment that reads back with its WSL deployment', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const [environment] = listEnvironments(userDataPath)
    expect(environment).toMatchObject({
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
    })
    expect(environment.connectionDependency).toBeUndefined()
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(100)
  })

  it('refuses a pairing that does not point at the bridge port', () => {
    expect(() =>
      addWslHostEnvironment(userDataPath, {
        id: 'wsl:ubuntu',
        name: 'Ubuntu (WSL)',
        pairingCode: code(43000),
        record
      })
    ).toThrow(/does not point at its bridge/)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('persists a relaunch’s new device token and a moved bridge, and says so', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    expect(
      refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
        pairingCode: code(42000),
        localPort: 42000,
        remotePort: 6768
      }).pairingChanged
    ).toBe(false)

    const refreshed = refreshWslHostPairing(
      userDataPath,
      'wsl:ubuntu',
      { pairingCode: code(42001, 'token-2'), localPort: 42001, remotePort: 6770 },
      500
    )
    expect(refreshed.pairingChanged).toBe(true)
    expect(getPreferredPairingOffer(refreshed.environment).deviceToken).toBe('token-2')
    expect(refreshed.environment.pairingRevision).toBe(500)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
      localPort: 42001,
      remotePort: 6770
    })
  })

  it('binds the record to the pairing key and follows a relaunch that changes it', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pairingPublicKeyB64).toBe(
      publicKeyB64
    )
    const rotatedKey = Buffer.alloc(32, 9).toString('base64')
    const refreshed = refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'token-2',
        publicKeyB64: rotatedKey
      }),
      localPort: 42000,
      remotePort: 6768
    })
    expect(refreshed.pairingChanged).toBe(true)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pairingPublicKeyB64).toBe(rotatedKey)
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ kind: 'wsl' })
  })

  it('writes nothing when a refreshed pairing does not point at the bridge', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const before = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    expect(() =>
      refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
        pairingCode: code(43000, 'token-2'),
        localPort: 42001,
        remotePort: 6770
      })
    ).toThrow(/does not point at its bridge/)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toEqual(before)
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ localPort: 42000 })
  })

  it('stays a WSL host if a key rotation is interrupted between its two writes', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const stored = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!stored) {
      throw new Error('record missing')
    }
    // The record write landed; the pairing write that follows it did not.
    writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      ...stored,
      pairingPublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
      previousPairingPublicKeyB64: publicKeyB64
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ kind: 'wsl' })
  })

  it('removes the environment and its record', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record
    })
    removeWslHostEnvironment(userDataPath, 'wsl:ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
  })
})
