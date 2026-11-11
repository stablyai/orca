import { pairedRuntimeConnectionFromOffer } from '../pairing/paired-runtime-connection'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { addEnvironmentFromPairingCode, listEnvironments } from './runtime-environment-store'
import {
  getRuntimeEnvironmentSidecarPath,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import {
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink
} from './runtime-environment-ssh-access-store'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
import { shippedBuildRewrite } from './runtime-environment-shipped-store.test-fixture'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token',
  pairedDeviceId: 'paired-client'
}
const tunnel = { sshTargetId: 'target', sshTargetGeneration: 3, localPort: 41000, remotePort: 6768 }

describe('runtime environment sidecar across a downgrade', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-sidecar-'))
  })
  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function linked() {
    const seeded = addEnvironmentFromPairingCode(userDataPath, {
      name: 'Host',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
    const prepared = prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment: seeded,
      requestId: 'link-request',
      ...tunnel,
      targetFingerprint: 'target-fingerprint'
    })
    return linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedConnection: pairedRuntimeConnectionFromOffer({
        ...pairing,
        endpoint: 'ws://127.0.0.1:41000/runtime'
      }),
      tunnel,
      now: 90
    })
  }

  it('keeps SSH access after a shipped build rewrites orca-environments.json', () => {
    const access = linked()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.lastUsedAt = 500
      environments[0]!.runtimeId = 'host-runtime'
    })
    const [restored] = listEnvironments(userDataPath)
    expect(restored?.sshAccess).toEqual(access.sshAccess)
    expect(restored?.preferredEndpointId).toBe(access.preferredEndpointId)
    expect(restored?.lastUsedAt).toBe(500)
  })

  it('reads a link as stale once a shipped build re-pairs the server, and prunes it on the next write', () => {
    const access = linked()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.pairingRevision = 200
    })
    const [restored] = listEnvironments(userDataPath)
    expect(restored?.sshAccess).toBeUndefined()
    expect(restored?.preferredEndpointId).toBe(access.sshAccess?.previousPreferredEndpointId)
    expect(restored?.connectionDependency).toBeUndefined()

    const persisted = readPersistedEnvironmentStore(userDataPath).environments
    writeRuntimeEnvironmentSidecarEntry(userDataPath, persisted, persisted[0]!, null)
    expect(
      JSON.parse(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8'))
    ).toEqual({ version: 1, entries: {} })
  })

  it('fails closed on an unreadable sidecar instead of dropping a pinned host key', () => {
    linked()
    writeFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), '{not json')
    expect(() => listEnvironments(userDataPath)).toThrow('Orca environment links')
  })
})
