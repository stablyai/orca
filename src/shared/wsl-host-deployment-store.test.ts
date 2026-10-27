import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addManagedOrcadEnvironment,
  recordManagedOrcadMigration
} from './runtime-environment-managed-orcad-store'
import {
  getRuntimeEnvironmentSidecarPath,
  overlayRuntimeEnvironmentSidecar,
  readRuntimeEnvironmentSidecar
} from './runtime-environment-sidecar'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed
} from './runtime-environment-store'
import {
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { RuntimeEnvironmentStoreSchema } from './runtime-environments'
import {
  getWslHostDeploymentStorePath,
  readWslHostDeployments,
  writeWslHostDeployment,
  WslHostDeploymentStoreInvalidError,
  type WslHostDeploymentRecord
} from './wsl-host-deployment-store'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from './wsl-host-internal-gate'

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

  it('leaves an SSH-only profile byte-for-byte unchanged across a read and rewrite', () => {
    addSshManaged()
    recordManagedOrcadMigration(userDataPath, 'ssh-managed', '2026-10-01T00:00:00.000Z')
    const storePath = getEnvironmentStorePath(userDataPath)
    const sidecarPath = getRuntimeEnvironmentSidecarPath(userDataPath)
    const before = { store: bytes(storePath), sidecar: bytes(sidecarPath) }

    const [environment] = listEnvironments(userDataPath)
    expect(environment?.orcadDeployment).toEqual(sshTunnel)
    writeEnvironmentStore(userDataPath, readPersistedEnvironmentStore(userDataPath))
    recordManagedOrcadMigration(userDataPath, 'ssh-managed', '2026-10-01T00:00:00.000Z')

    expect({ store: bytes(storePath), sidecar: bytes(sidecarPath) }).toEqual(before)
    expect(before.sidecar).not.toContain('"kind"')
    expect(existsSync(getWslHostDeploymentStorePath(userDataPath))).toBe(false)
  })

  it('overlays a WSL deployment as a managed server without touching the shared files', () => {
    addSshManaged()
    const storeBefore = bytes(getEnvironmentStorePath(userDataPath))
    const sidecarBefore = bytes(getRuntimeEnvironmentSidecarPath(userDataPath))
    const wslId = addWslManaged()

    const byId = new Map(listEnvironments(userDataPath).map((entry) => [entry.id, entry]))
    expect(byId.get('ssh-managed')?.orcadDeployment).toEqual(sshTunnel)
    const { environmentId: _id, createdAt: _at, ...link } = wslRecord()
    expect(byId.get(wslId)).toMatchObject({ orcadDeployment: link })
    expect(byId.get(wslId)?.connectionDependency).toBeUndefined()
    expect(bytes(getRuntimeEnvironmentSidecarPath(userDataPath))).toBe(sidecarBefore)
    expect(bytes(getEnvironmentStorePath(userDataPath))).not.toContain('wsl')
    expect(storeBefore).not.toContain('wsl')
  })

  describe('downgrade to builds that never read the WSL file', () => {
    it('keeps every environment readable by a build that rejects the whole store on one bad record', () => {
      addSshManaged()
      const wslId = addWslManaged()

      // Builds before the per-record store parsed orca-environments.json whole.
      const strict = RuntimeEnvironmentStoreSchema.parse(
        JSON.parse(bytes(getEnvironmentStorePath(userDataPath)))
      )
      expect(strict.environments.map((entry) => entry.id).sort()).toEqual(
        ['ssh-managed', wslId].sort()
      )
      expect(Object.keys(readRuntimeEnvironmentSidecar(userDataPath).unreadable)).toEqual([])
    })

    it("keeps SSH servers managed under main's reader, which sees the WSL server as a plain pairing", () => {
      addSshManaged()
      const wslId = addWslManaged()

      const sidecar = readRuntimeEnvironmentSidecar(userDataPath)
      const mainView = readPersistedEnvironmentStore(userDataPath).environments.map((entry) =>
        overlayRuntimeEnvironmentSidecar(entry, sidecar.entries[entry.id])
      )
      const byId = new Map(mainView.map((entry) => [entry.id, entry]))
      expect(byId.get('ssh-managed')?.orcadDeployment).toEqual(sshTunnel)
      expect(byId.get(wslId)?.orcadDeployment).toBeUndefined()
    })

    it('keeps the WSL deployment after an older build rewrites the store', () => {
      addSshManaged()
      const wslId = addWslManaged()
      // An older build's routine write: parse, strip unknown keys, rewrite.
      const path = getEnvironmentStorePath(userDataPath)
      writeFileSync(
        path,
        JSON.stringify(RuntimeEnvironmentStoreSchema.parse(JSON.parse(bytes(path))), null, 2)
      )
      markEnvironmentUsed(userDataPath, wslId, { now: 10_000 })

      expect(listEnvironments(userDataPath).find((entry) => entry.id === wslId)).toMatchObject({
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      })
    })
  })

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

    it('fails closed when the file itself is corrupt and WSL hosts are enabled', () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
      addSshManaged()
      writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{"version":1,"deployments":{}}')
      expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
      expect(() => writeWslHostDeployment(userDataPath, 'x', null)).toThrow(
        WslHostDeploymentStoreInvalidError
      )
    })

    it('keeps every other server listed when the file is corrupt and the gate is closed', () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
      addSshManaged()
      writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{"version":1,"deployments":{}}')
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['ssh-managed'])
    })

    it('hides nothing for an unreadable record while the gate is closed', () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
      const wslId = addWslManaged()
      seed({ ...futureKind, environmentId: wslId })
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([wslId])
    })

    it('never hides a remote paired server behind an unreadable WSL record', () => {
      const remote = addEnvironmentFromPairingCode(userDataPath, {
        name: 'Remote',
        pairingCode: encodePairingOffer({
          ...pairing,
          publicKeyB64: Buffer.alloc(32, 3).toString('base64'),
          endpoint: 'wss://build.example.com/runtime'
        }),
        now: 150
      })
      seed({ ...futureKind, environmentId: remote.id })
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([remote.id])
    })

    it('never hides an SSH-managed server behind an unreadable WSL record', () => {
      addSshManaged()
      seed({ ...futureKind, environmentId: 'ssh-managed' })
      expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toEqual(sshTunnel)
    })
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

  it('overlays a record bound to the pairing key (keyless records keep port-only binding)', () => {
    addWslManaged(wslRecord({ pairingPublicKeyB64: WSL_PAIRING_KEY }))
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu-24.04',
      distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
      localPort: 42000,
      remotePort: 6769
    })
  })

  it('ignores a WSL record on a server that already has an SSH deployment', () => {
    addSshManaged()
    writeWslHostDeployment(
      userDataPath,
      'ssh-managed',
      wslRecord({ environmentId: 'ssh-managed', localPort: 41000 })
    )
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toEqual(sshTunnel)
  })

  it('rejects a record written under another environment id or with an invalid distro', () => {
    expect(() => writeWslHostDeployment(userDataPath, 'other', wslRecord())).toThrow()
    expect(() =>
      writeWslHostDeployment(userDataPath, 'wsl-ubuntu', wslRecord({ distro: 'Ubuntu 24.04' }))
    ).toThrow()
    expect(() =>
      writeWslHostDeployment(userDataPath, 'wsl-ubuntu', wslRecord({ distroId: '{ABC}' }))
    ).toThrow()
  })
})
