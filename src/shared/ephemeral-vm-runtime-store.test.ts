import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: secure-file has dedicated ACL coverage; this suite focuses on store semantics.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('records a lifecycle failure with an empty message instead of rejecting the write', () => {
    const userDataPath = makeUserDataPath()
    const record = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())

    const failed = updateEphemeralVmRuntimeStatus(userDataPath, record.id, {
      status: 'resume_failed',
      lifecycleLastError: { error: '' }
    })
    expect(failed).toMatchObject({ status: 'resume_failed', lifecycleLastError: 'Unknown error.' })

    const resumed = updateEphemeralVmRuntimeStatus(userDataPath, record.id, {
      status: 'running',
      lifecycleLastError: null
    })
    expect(resumed.lifecycleLastError).toBeUndefined()
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
