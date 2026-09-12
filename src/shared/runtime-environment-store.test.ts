import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  markEnvironmentUsed,
  restoreManagedOrcadEnvironmentLink,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'

function pairingCode(endpoint = 'ws://127.0.0.1:6768', pairedDeviceId?: string): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('runtime environment store', () => {
  const tempDirs: string[] = []
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: this suite tests store timestamps, while secure-file tests cover Windows ACLs.
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

  it('rejects duplicate server names instead of silently replacing the saved server', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'dev box',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it('accepts a caller-owned id and rejects duplicate ids', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const environment = addEnvironmentFromPairingCode(userDataPath, {
      id: 'managed-environment',
      name: 'managed box',
      pairingCode: pairingCode()
    })

    expect(environment.id).toBe('managed-environment')
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        id: 'managed-environment',
        name: 'another name',
        pairingCode: pairingCode()
      })
    ).toThrow('already exists')
  })

  it('advances pairing revisions across equal and backward clock readings', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode(),
      now: 100
    })

    const sameClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })
    const backwardClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      now: 50
    })
    const laterClock = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.12:6768'),
      now: 200
    })

    expect([
      sameClock.pairingRevision,
      backwardClock.pairingRevision,
      laterClock.pairingRevision
    ]).toEqual([101, 102, 200])
  })

  it('keeps SSH-tunnel metadata only while the pairing endpoint is loopback', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'tunneled box',
      pairingCode: pairingCode(),
      connectionDependency: 'ssh-tunnel'
    })
    expect(environment.connectionDependency).toBe('ssh-tunnel')

    const updated = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(updated).not.toHaveProperty('connectionDependency')

    const direct = addEnvironmentFromPairingCode(userDataPath, {
      name: 'direct box',
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      connectionDependency: 'ssh-tunnel'
    })
    expect(direct).not.toHaveProperty('connectionDependency')
  })

  it('persists the orcad deployment identity across loopback re-pairing', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const orcadDeployment = {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 7,
      localPort: 46_768,
      remotePort: 6_768
    }
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'managed box',
      pairingCode: pairingCode(),
      connectionDependency: 'ssh-tunnel',
      orcadDeployment
    })

    expect(environment.orcadDeployment).toEqual(orcadDeployment)
    expect(
      updateEnvironmentFromPairingCode(userDataPath, environment.id, {
        pairingCode: pairingCode('ws://localhost:46768')
      }).orcadDeployment
    ).toEqual(orcadDeployment)
  })

  it('drops the orcad deployment identity when re-paired to a direct endpoint', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'managed box',
      pairingCode: pairingCode(),
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: {
        sshTargetId: 'ssh-prod',
        sshTargetGeneration: 7,
        localPort: 46_768,
        remotePort: 6_768
      }
    })

    const updated = updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('wss://runtime.example.com')
    })
    expect(updated).not.toHaveProperty('orcadDeployment')
  })

  it('restores stripped managed deployment metadata without changing environment identity', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      id: 'managed-environment',
      name: 'managed box',
      pairingCode: pairingCode('ws://localhost:46768', 'paired-device'),
      connectionDependency: 'ssh-tunnel',
      now: 1_000
    })
    markEnvironmentUsed(userDataPath, environment.id, {
      runtimeId: 'runtime-1',
      now: 2_000
    })
    const before = listEnvironments(userDataPath)[0]!

    const restored = restoreManagedOrcadEnvironmentLink(userDataPath, environment.id, {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 7,
      remotePort: 6_768
    })

    expect(restored).toEqual({
      ...before,
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: {
        sshTargetId: 'ssh-prod',
        sshTargetGeneration: 7,
        localPort: 46_768,
        remotePort: 6_768
      }
    })
    expect(listEnvironments(userDataPath)).toEqual([restored])
  })

  it('refuses to restore a managed link from an ambiguous endpoint or conflicting identity', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const direct = addEnvironmentFromPairingCode(userDataPath, {
      name: 'direct box',
      pairingCode: pairingCode('ws://192.0.2.10:46768')
    })
    expect(() =>
      restoreManagedOrcadEnvironmentLink(userDataPath, direct.id, {
        sshTargetId: 'ssh-prod',
        sshTargetGeneration: 7,
        remotePort: 6_768
      })
    ).toThrow('explicit loopback endpoint')

    const managed = addEnvironmentFromPairingCode(userDataPath, {
      name: 'managed box',
      pairingCode: pairingCode('ws://127.0.0.1:46769'),
      connectionDependency: 'ssh-tunnel',
      orcadDeployment: {
        sshTargetId: 'ssh-prod',
        sshTargetGeneration: 8,
        localPort: 46_769,
        remotePort: 6_768
      }
    })
    expect(() =>
      restoreManagedOrcadEnvironmentLink(userDataPath, managed.id, {
        sshTargetId: 'ssh-prod',
        sshTargetGeneration: 7,
        remotePort: 6_768
      })
    ).toThrow('conflicting deployment metadata')
    expect(listEnvironments(userDataPath)).toEqual([direct, managed])
  })

  it('throttles lastUsedAt writes so it does not rewrite the store on every runtime call', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    // First use persists (lastUsedAt started null).
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 1_000,
      runtimeId: 'runtime-1'
    })

    // A second use shortly after, same runtime, is skipped — lastUsedAt stays put.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 5_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(1_000)

    // Once the throttle window elapses, it persists again.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 61_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(61_000)
  })

  it('persists immediately when the runtimeId changes within the throttle window', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    // A different runtimeId inside the window must not be dropped.
    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-2', now: 2_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 2_000,
      runtimeId: 'runtime-2'
    })
  })

  it('persists paired device identity from pairing and status backfill', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const paired = addEnvironmentFromPairingCode(userDataPath, {
      name: 'paired box',
      pairingCode: pairingCode('ws://127.0.0.1:6768', 'device-from-offer'),
      now: 1_000
    })
    const legacy = addEnvironmentFromPairingCode(userDataPath, {
      name: 'legacy box',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 1_000
    })

    expect(paired.pairedDeviceId).toBe('device-from-offer')
    markEnvironmentUsed(userDataPath, legacy.id, {
      pairedDeviceId: 'device-from-status',
      now: 2_000
    })
    expect(listEnvironments(userDataPath).find((entry) => entry.id === legacy.id)).toMatchObject({
      pairedDeviceId: 'device-from-status',
      lastUsedAt: 2_000
    })
  })

  it('rejects an oversized sparse environment store before parsing it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-bound-'))
    tempDirs.push(userDataPath)
    const path = getEnvironmentStorePath(userDataPath)
    writeFileSync(path, '{"version":1,"environments":[]}')
    truncateSync(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES + 1)

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
  })

  it('rejects an oversized write without replacing the durable environment list', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-write-bound-'))
    tempDirs.push(userDataPath)
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })
})
