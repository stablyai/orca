import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import { listEnvironments } from './runtime-environment-store'
import {
  addWslHostEnvironment,
  findWslHostDeployment,
  reconcileWslHostBridgePorts,
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

  it('saves a moved bridge without reading its new record against the old pairing', () => {
    // An id of its own: the conflict warning is logged once per message per process.
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:moved-bridge',
      name: 'Moved (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const warn = vi.mocked(console.warn)
    warn.mockClear()

    const refreshed = refreshWslHostPairing(userDataPath, 'wsl:moved-bridge', {
      pairingCode: code(42001),
      localPort: 42001,
      remotePort: 6768
    })

    expect(refreshed.pairingChanged).toBe(true)
    expect(refreshed.environment.orcadDeployment).toMatchObject({ kind: 'wsl', localPort: 42001 })
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/conflicts with the server's pairing/)
  })

  it('heals a crash between saving the moved bridge and its pairing, keeping the saved pairing', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:crashed',
      name: 'Crashed (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const saved = findWslHostDeployment(userDataPath, 'wsl:crashed')!
    // The crash: refreshWslHostPairing's first write landed, its pairing write never did.
    writeWslHostDeployment(userDataPath, 'wsl:crashed', {
      ...saved,
      localPort: 42001,
      remotePort: 6770
    })
    const [crashed] = listEnvironments(userDataPath)
    expect(crashed.orcadDeployment).toBeUndefined()

    expect(reconcileWslHostBridgePorts(userDataPath)).toEqual(['wsl:crashed'])
    const [healed] = listEnvironments(userDataPath)
    expect(healed.orcadDeployment).toMatchObject({
      kind: 'wsl',
      localPort: 42000,
      remotePort: 6770
    })
    expect(getPreferredPairingOffer(healed)).toEqual(getPreferredPairingOffer(crashed))
    expect(reconcileWslHostBridgePorts(userDataPath)).toEqual([])

    // The next connect saves both.
    refreshWslHostPairing(userDataPath, 'wsl:crashed', {
      pairingCode: code(42002, 'token-2'),
      localPort: 42002,
      remotePort: 6770
    })
    expect(listEnvironments(userDataPath)[0].orcadDeployment).toMatchObject({ localPort: 42002 })
  })

  it('leaves a record alone when its server has no pairing to follow', () => {
    writeWslHostDeployment(userDataPath, 'wsl:orphan', {
      ...record,
      environmentId: 'wsl:orphan',
      createdAt: 1
    })
    expect(reconcileWslHostBridgePorts(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:orphan')?.localPort).toBe(42000)
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

  // A golden image with a baked-in orcad key: each distro is its own host, with its own grant.
  it('keeps two distros that carry the same orcad key as two hosts', () => {
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000, 'token-ubuntu'),
      record
    })
    addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu-2',
      name: 'Ubuntu-2 (WSL)',
      pairingCode: code(42001, 'token-ubuntu-2'),
      record: { ...record, distro: 'Ubuntu-2', localPort: 42001 }
    })
    const environments = listEnvironments(userDataPath)
    expect(environments.map((environment) => environment.id)).toEqual([
      'wsl:ubuntu',
      'wsl:ubuntu-2'
    ])
    expect(environments.map((environment) => getPreferredPairingOffer(environment))).toEqual([
      expect.objectContaining({ publicKeyB64, deviceToken: 'token-ubuntu' }),
      expect.objectContaining({ publicKeyB64, deviceToken: 'token-ubuntu-2' })
    ])
  })
})
