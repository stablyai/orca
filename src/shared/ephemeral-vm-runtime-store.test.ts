import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from './pairing'
import {
  EphemeralVmRuntimeStoreError,
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
  removeEphemeralVmRuntime,
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

  it('persists recipe-created runtimes separately from saved remote environments', () => {
    const userDataPath = makeUserDataPath()
    const first = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const second = upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        id: 'orca-instance-2',
        createdAt: 2_000,
        updatedAt: 2_000,
        recipeResult: {
          schemaVersion: 1,
          pairingCode: pairingCode('wss://sandbox-2.example.com'),
          projectRoot: '/workspace/repo'
        }
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([second, first])
  })

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

  it('persists runtime connection metadata', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(
      userDataPath,
      runtimeRecord({
        connectionMode: 'ssh',
        sshTargetId: 'runtime-ssh-orca-instance-1',
        recipeResult: {
          schemaVersion: 1,
          connection: {
            type: 'ssh',
            projectRoot: '/workspace/repo',
            target: {
              label: 'Sandbox',
              host: 'sandbox.example.com',
              port: 22,
              username: 'root'
            }
          }
        }
      })
    )

    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      connectionMode: 'ssh',
      sshTargetId: 'runtime-ssh-orca-instance-1',
      recipeResult: {
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo'
        }
      }
    })
  })

  it('removes cleaned runtimes', () => {
    const userDataPath = makeUserDataPath()
    const record = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())

    expect(removeEphemeralVmRuntime(userDataPath, record.id)).toEqual(record)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('throws a store error for invalid persisted JSON', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(getEphemeralVmRuntimeStorePath(userDataPath), '{ nope', 'utf8')

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
  })

  it('rejects an oversized sparse runtime store before parsing it', () => {
    const userDataPath = makeUserDataPath()
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    writeFileSync(path, '{"version":1,"runtimes":[]}', 'utf8')
    truncateSync(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES + 1)

    expect(() => listEphemeralVmRuntimes(userDataPath)).toThrow(EphemeralVmRuntimeStoreError)
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
