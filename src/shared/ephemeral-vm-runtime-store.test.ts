import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from './testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from './remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  EphemeralVmRuntimeStoreError,
  listEphemeralVmRuntimes,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

function pairingCode(endpoint = 'wss://sandbox.example.com'): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'orca-instance-1',
    recipeId: 'cloud-sandbox',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix Login Race',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: pairingCode(),
      projectRoot: '/workspace/repo',
      userData: { providerResourceId: 'sandbox-123' }
    },
    ...overrides
  }
}

describe('ephemeral VM runtime store', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  function makeUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ephemeral-vm-store-'))
    tempDirs.push(userDataPath)
    return userDataPath
  }

  it('updates lifecycle and cleanup state', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())

    const failed = updateEphemeralVmRuntimeStatus(userDataPath, 'orca-instance-1', {
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastAttemptAt: 3_000,
      cleanupLastError: 'provider delete failed',
      updatedAt: 3_000
    })

    expect(failed).toMatchObject({
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastAttemptAt: 3_000,
      cleanupLastError: 'provider delete failed',
      updatedAt: 3_000
    })

    const recovered = updateEphemeralVmRuntimeStatus(userDataPath, 'orca-instance-1', {
      status: 'cleaned',
      cleanupStatus: 'succeeded',
      cleanupLastError: null,
      updatedAt: 4_000
    })

    expect(recovered).toMatchObject({
      status: 'cleaned',
      cleanupStatus: 'succeeded',
      updatedAt: 4_000
    })
    expect(recovered.cleanupLastError).toBeUndefined()
  })

  it('rejects an oversized write without publishing a partial runtime record', () => {
    const userDataPath = makeUserDataPath()

    expect(() =>
      upsertEphemeralVmRuntime(
        userDataPath,
        runtimeRecord({
          cleanupLastError: 'x'.repeat(MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES)
        })
      )
    ).toThrow(EphemeralVmRuntimeStoreError)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })
})
