import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import {
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import {
  addManagedOrcadEnvironment,
  moveManagedOrcadLocalPort,
  refreshManagedOrcadPairing
} from './runtime-environment-managed-orcad-store'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
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

  it('keeps a managed server from being removed or re-paired outside its lifecycle', () => {
    add()
    expect(() => removeEnvironment(userDataPath, 'Managed')).toThrow(
      'Orca runs this server on an SSH host for you'
    )
    expect(() =>
      updateEnvironmentFromPairingCode(userDataPath, 'Managed', { pairingCode: pairingCode() })
    ).toThrow('Orca runs this server on an SSH host for you')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
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

  it('keeps a moved tunnel port consistent at every point of its two-file write', () => {
    const before = add()
    const store = readPersistedEnvironmentStore(userDataPath)
    const existing = store.environments[0]!
    const { binding: _binding, ...state } = readCurrentRuntimeEnvironmentSidecarEntry(
      userDataPath,
      existing
    )!
    const movedEndpoint = { ...existing.endpoints[0]!, endpoint: 'ws://127.0.0.1:50001/' }
    const next = { ...existing, pairingRevision: 500, endpoints: [movedEndpoint] }
    // The first write of a move, then a store that landed on the moved endpoint.
    writeRuntimeEnvironmentSidecarEntry(userDataPath, store.environments, existing, state, next)
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment, 'store not yet written').toEqual(
      deployment
    )
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0] = next
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment, 'store written').toEqual({
      ...deployment,
      localPort: 50_001
    })

    const moved = moveManagedOrcadLocalPort(userDataPath, 'environment-1', 50_002, 600)
    expect(moved.orcadDeployment).toEqual({ ...deployment, localPort: 50_002 })
    expect(moved.endpoints[0]?.deviceToken).toBe(before.endpoints[0]?.deviceToken)
    expect(listEnvironments(userDataPath)[0]).toEqual(moved)
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
})
