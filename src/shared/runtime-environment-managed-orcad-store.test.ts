import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import {
  addManagedOrcadEnvironment,
  recordManagedOrcadMigration,
  refreshManagedOrcadPairing,
  removeManagedOrcadEnvironment
} from './runtime-environment-managed-orcad-store'
import {
  getRuntimeEnvironmentSidecarPath,
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
import { getRuntimeSshAccess } from './runtime-environments'
import { shippedBuildRewrite } from './runtime-environment-shipped-store.test-fixture'

const deployment = {
  sshTargetId: 'ssh-1',
  sshTargetGeneration: 4,
  localPort: 46_768,
  remotePort: 6_768
}
const pairingCode = (endpoint = 'ws://127.0.0.1:46768') =>
  encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'private-device-token',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64')
  })

describe('managed orcad environment store', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-managed-orcad-store-'))
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  const add = (overrides: Partial<Parameters<typeof addManagedOrcadEnvironment>[1]> = {}) =>
    addManagedOrcadEnvironment(userDataPath, {
      id: 'environment-1',
      name: 'Managed',
      pairingCode: pairingCode(),
      orcadDeployment: deployment,
      now: 100,
      ...overrides
    })

  it('keeps the deployment link out of the file shipped builds rewrite', () => {
    const environment = add()
    expect(environment.orcadDeployment).toEqual(deployment)
    expect(getRuntimeSshAccess(environment)).toEqual(deployment)
    const persisted = readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')
    expect(persisted).not.toContain('orcadDeployment')
    expect(persisted).toContain('"connectionDependency":"ssh-tunnel"')
    expect(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')).not.toContain(
      'private-device-token'
    )
  })

  it('survives a downgraded build rewriting orca-environments.json', () => {
    add()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.lastUsedAt = 500
    })
    const [restored] = listEnvironments(userDataPath)
    expect(restored?.orcadDeployment).toEqual(deployment)
    expect(restored?.lastUsedAt).toBe(500)
  })

  it('drops the link when a downgraded build re-pairs the server elsewhere', () => {
    add()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.pairingRevision = 200
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toBeUndefined()
  })

  it('refuses a pairing that does not point at the deployment tunnel', () => {
    expect(() => add({ pairingCode: pairingCode('ws://127.0.0.1:1234') })).toThrow(
      'does not point at its SSH tunnel'
    )
    expect(() => add({ pairingCode: pairingCode('wss://server.example') })).toThrow()
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('refuses duplicate ids and names', () => {
    add()
    expect(() => add({ name: 'Other' })).toThrow('already exists')
    expect(() => add({ id: 'environment-2' })).toThrow('already exists')
  })

  it('keeps a managed server from being removed or re-paired outside its lifecycle', () => {
    add()
    expect(() => removeEnvironment(userDataPath, 'Managed')).toThrow('managed by Orca over SSH')
    expect(() =>
      updateEnvironmentFromPairingCode(userDataPath, 'Managed', { pairingCode: pairingCode() })
    ).toThrow('managed by Orca over SSH')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('removes the server and its deployment record together once it is unlinked', () => {
    add()
    removeManagedOrcadEnvironment(userDataPath, 'environment-1')
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')).not.toContain(
      'environment-1'
    )
  })

  it('leaves an unchanged pairing alone and re-binds the link when the offer rotates', () => {
    const environment = add()
    expect(refreshManagedOrcadPairing(userDataPath, 'environment-1', pairingCode())).toEqual(
      environment
    )
    const rotated = encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'rotated-token',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
    const refreshed = refreshManagedOrcadPairing(userDataPath, 'environment-1', rotated, 500)
    expect(refreshed.endpoints[0]?.deviceToken).toBe('rotated-token')
    expect(refreshed.pairingRevision).toBe(500)
    expect(refreshed.orcadDeployment).toEqual(deployment)
    expect(() =>
      refreshManagedOrcadPairing(userDataPath, 'environment-1', pairingCode('ws://127.0.0.1:1'))
    ).toThrow('does not point at its SSH tunnel')
  })

  it('keeps the deployment link when a re-pair stops between its sidecar and store writes', () => {
    add()
    const store = readPersistedEnvironmentStore(userDataPath)
    const existing = store.environments[0]!
    const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)!
    const { binding: _binding, ...state } = entry
    // The first write of a refresh, then a store that landed on the new pairing revision.
    writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, existing, state, {
      ...existing,
      pairingRevision: 500
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment, 'store not yet written').toEqual(
      deployment
    )
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.pairingRevision = 500
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment, 'store written').toEqual(deployment)
  })

  it('keeps the re-paired device identity when a reply from the previous pairing lands late', () => {
    const offer = (deviceToken: string, pairedDeviceId: string) =>
      encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:46768',
        deviceToken,
        publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
        pairedDeviceId
      })
    add({ pairingCode: offer('token-old', 'device-old') })
    const repaired = refreshManagedOrcadPairing(
      userDataPath,
      'environment-1',
      offer('token-new', 'device-new'),
      500
    )
    expect(repaired).toMatchObject({ pairedDeviceId: 'device-new', pairingRevision: 500 })

    // A status reply authenticated with the old token finishes after the re-pair.
    markEnvironmentUsed(userDataPath, 'environment-1', {
      pairedDeviceId: 'device-old',
      pairingDeviceToken: 'token-old',
      now: 600
    })
    const after = listEnvironments(userDataPath)[0]
    expect(after?.pairedDeviceId).toBe('device-new')
    expect(after?.endpoints[0]?.deviceToken).toBe('token-new')
    expect(after?.orcadDeployment).toEqual(deployment)
  })

  it('keeps the latest migration mark and never moves it back, across a downgrade rewrite and a re-pair', () => {
    add()
    recordManagedOrcadMigration(userDataPath, 'environment-1', '2026-02-01T00:00:00.000Z')
    recordManagedOrcadMigration(userDataPath, 'environment-1', '2026-03-01T00:00:00.000Z')
    recordManagedOrcadMigration(userDataPath, 'environment-1', '2026-02-15T00:00:00.000Z')
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.lastUsedAt = 900
    })
    expect(listEnvironments(userDataPath)[0]?.orcadMigratedAt).toBe('2026-03-01T00:00:00.000Z')
    const rotated = encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'rotated-token',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
    expect(
      refreshManagedOrcadPairing(userDataPath, 'environment-1', rotated, 500).orcadMigratedAt
    ).toBe('2026-03-01T00:00:00.000Z')
  })
})
