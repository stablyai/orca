import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../pairing/mobile-relay-pairing-offer'
import {
  EphemeralVmRuntimeStoreError,
  listEphemeralVmRuntimes,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
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
