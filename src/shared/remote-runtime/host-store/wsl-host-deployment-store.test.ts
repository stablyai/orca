import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'
import { addEnvironmentFromPairingCode, listEnvironments } from './runtime-environment-store'
import {
  getWslHostDeploymentStorePath,
  readWslHostDeployments,
  writeWslHostDeployment,
  WslHostDeploymentStoreInvalidError,
  type WslHostDeploymentRecord
} from './wsl-host-deployment-store'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../wsl-host-internal-gate'

const pairing = {
  v: 2 as const,
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token'
}
const WSL_PAIRING_KEY = Buffer.alloc(32, 2).toString('base64')
const sshTunnel = {
  sshTargetId: 'target',
  sshTargetGeneration: 3,
  localPort: 41000,
  remotePort: 6768
}

function wslRecord(overrides: Partial<WslHostDeploymentRecord> = {}): WslHostDeploymentRecord {
  return {
    kind: 'wsl',
    environmentId: 'wsl-ubuntu',
    distro: 'Ubuntu-24.04',
    distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
    localPort: 42000,
    remotePort: 6769,
    createdAt: 200,
    ...overrides
  }
}

describe('WSL host deployment store', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-deployments-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function addSshManaged() {
    return addManagedOrcadEnvironment(userDataPath, {
      id: 'ssh-managed',
      name: 'Build box',
      pairingCode: encodePairingOffer({ ...pairing, endpoint: 'ws://127.0.0.1:41000/runtime' }),
      orcadDeployment: sshTunnel,
      now: 100
    })
  }

  // Keep the pairing store readable by older builds.
  function addWslManaged(record = wslRecord()) {
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Ubuntu',
      // Each pairing key identifies one server; duplicate keys are rejected.
      pairingCode: encodePairingOffer({
        ...pairing,
        publicKeyB64: WSL_PAIRING_KEY,
        endpoint: `ws://127.0.0.1:${record.localPort}/runtime`
      }),
      now: 150
    })
    writeWslHostDeployment(userDataPath, environment.id, {
      ...record,
      environmentId: environment.id
    })
    return environment.id
  }

  function bytes(path: string): string {
    return readFileSync(path, 'utf8')
  }

  describe('records this build cannot read', () => {
    const futureKind = { kind: 'hyperv', environmentId: 'future', vmName: 'dev', createdAt: 1 }
    const corrupt = { kind: 'wsl', environmentId: 'broken', distro: 'not a name!' }
    const anonymous = { note: 'no environment id' }

    function seed(...records: unknown[]): string {
      const path = getWslHostDeploymentStorePath(userDataPath)
      writeFileSync(path, JSON.stringify({ version: 1, deployments: records }))
      return path
    }

    it('rewrites unknown records verbatim and in place when another record changes', () => {
      const extended = { ...wslRecord({ environmentId: 'extended' }), futureField: { x: 1 } }
      const path = seed(futureKind, extended, corrupt, anonymous)

      writeWslHostDeployment(userDataPath, 'new', wslRecord({ environmentId: 'new' }))
      writeWslHostDeployment(
        userDataPath,
        'new',
        wslRecord({ environmentId: 'new', remotePort: 7000 })
      )

      expect(JSON.parse(bytes(path)).deployments).toEqual([
        futureKind,
        extended,
        corrupt,
        anonymous,
        wslRecord({ environmentId: 'new', remotePort: 7000 })
      ])
      writeWslHostDeployment(userDataPath, 'new', null)
      expect(JSON.parse(bytes(path)).deployments).toEqual([
        futureKind,
        extended,
        corrupt,
        anonymous
      ])
    })

    it('hides the environment an unreadable record owns and refuses to replace that record', () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
      addSshManaged()
      const wslId = addWslManaged()
      const future = { ...futureKind, environmentId: wslId }
      seed(future)

      expect(readWslHostDeployments(userDataPath).unreadableEnvironmentIds).toEqual(
        new Set([wslId])
      )
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['ssh-managed'])
      expect(() => writeWslHostDeployment(userDataPath, wslId, null)).toThrow(
        WslHostDeploymentStoreInvalidError
      )
      expect(JSON.parse(bytes(getWslHostDeploymentStorePath(userDataPath))).deployments).toEqual([
        future
      ])
    })

    it('treats two records for one environment as unreadable', () => {
      seed(wslRecord(), wslRecord({ remotePort: 7000 }))
      expect(readWslHostDeployments(userDataPath)).toEqual({
        deployments: [],
        unreadableEnvironmentIds: new Set(['wsl-ubuntu'])
      })
    })

    // Stack audit W-2: a corrupt file hid every SSH and paired server while hosts were served.
    function addRemotePaired() {
      return addEnvironmentFromPairingCode(userDataPath, {
        name: 'Remote',
        pairingCode: encodePairingOffer({
          ...pairing,
          publicKeyB64: Buffer.alloc(32, 3).toString('base64'),
          endpoint: 'wss://build.example.com/runtime'
        }),
        now: 160
      }).id
    }

    it.each([
      ['corrupt', '{"version":1,"deployments":{}}'],
      ['written by a newer envelope', '{"version":2,"deployments":[]}']
    ])(
      'keeps SSH and paired servers when the file is %s and WSL hosts are enabled',
      (_label, contents) => {
        vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
        addSshManaged()
        const remote = addRemotePaired()
        const wslId = addWslManaged()
        writeFileSync(getWslHostDeploymentStorePath(userDataPath), contents)
        // Only the server that could be a WSL host is hidden: its pins live in the unreadable file.
        expect(
          listEnvironments(userDataPath)
            .map((entry) => entry.id)
            .sort()
        ).toEqual([remote, 'ssh-managed'].sort())
        expect(listEnvironments(userDataPath).map((entry) => entry.id)).not.toContain(wslId)
        // Writes still refuse it, so a newer build's file is kept as it is.
        expect(() => writeWslHostDeployment(userDataPath, 'x', null)).toThrow(
          WslHostDeploymentStoreInvalidError
        )
        expect(readFileSync(getWslHostDeploymentStorePath(userDataPath), 'utf8')).toBe(contents)
      }
    )
  })

  it('ignores a stale record whose port no longer matches the pairing', () => {
    const wslId = addWslManaged()
    writeWslHostDeployment(
      userDataPath,
      wslId,
      wslRecord({ environmentId: wslId, localPort: 43000 })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.id).toBe(wslId)
    expect(environment?.orcadDeployment).toBeUndefined()
  })

  it('ignores a record written for another server re-paired under the same id and port', () => {
    const wslId = addWslManaged(
      wslRecord({ pairingPublicKeyB64: Buffer.alloc(32, 3).toString('base64') })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.id).toBe(wslId)
    expect(environment?.orcadDeployment).toBeUndefined()
  })
})
