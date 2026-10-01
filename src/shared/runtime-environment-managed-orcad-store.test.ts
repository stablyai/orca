import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import { getRuntimeSshAccess } from './runtime-environments'
import { shippedBuildRewrite } from './runtime-environment-shipped-store-fixture'

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
})
