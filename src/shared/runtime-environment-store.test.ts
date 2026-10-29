import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  markEnvironmentUsed,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'

function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  pairedDeviceId?: string,
  keyFill = 1
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyFill)).toString('base64'),
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

  function writeProfileKeypair(userDataPath: string, fill: number): void {
    const publicKeyB64 = Buffer.from(new Uint8Array(32).fill(fill)).toString('base64')
    writeFileSync(
      join(userDataPath, 'orca-e2ee-keypair.json'),
      JSON.stringify({ v: 1, publicKeyB64, secretKeyB64: publicKeyB64 })
    )
  }

  it('refuses a pairing code that this same Orca profile issued', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    writeProfileKeypair(userDataPath, 1)

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'myself',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(/this Orca itself/)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('refuses re-pairing a saved server with a code this same Orca profile issued', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })
    writeProfileKeypair(userDataPath, 1)

    expect(() =>
      updateEnvironmentFromPairingCode(userDataPath, environment.id, {
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([environment])
  })

  it('pairs a server with a different key even at a loopback address', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    writeProfileKeypair(userDataPath, 2)

    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'tunnel',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })
    expect(listEnvironments(userDataPath)).toEqual([environment])
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
        pairingCode: pairingCode('ws://192.0.2.10:6768', undefined, 2)
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it('rejects a name that differs only in case or surrounding spaces, as --environment resolves it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'build',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    for (const name of ['Build', ' build ', '"build"']) {
      expect(() =>
        addEnvironmentFromPairingCode(userDataPath, {
          name,
          pairingCode: pairingCode('ws://192.0.2.10:6768', undefined, 2)
        })
      ).toThrow('A server named "build" already exists.')
    }
    expect(listEnvironments(userDataPath)).toEqual([first])
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
      pairingCode: pairingCode('ws://192.0.2.11:6768', undefined, 2),
      connectionDependency: 'ssh-tunnel'
    })
    expect(direct).not.toHaveProperty('connectionDependency')
  })

  it('throttles lastUsedAt writes so it does not rewrite the store on every runtime call', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 1_000,
      runtimeId: 'runtime-1'
    })

    markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 5_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(1_000)

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
      pairingCode: pairingCode('ws://192.0.2.10:6768', undefined, 2),
      now: 1_000
    })

    expect(paired.pairedDeviceId).toBe('device-from-offer')
    markEnvironmentUsed(userDataPath, legacy.id, {
      pairedDeviceId: 'device-from-status',
      pairingDeviceToken: legacy.endpoints[0]!.deviceToken,
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

  it('backs up a NUL-filled store when a server is saved over it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-nul-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))

    // Plain reads stay fail-closed: an empty answer would read as "every server was removed".
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    // A save that fails must leave the blank file, not an empty registry, behind.
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode()
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    const added = addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    expect(listEnvironments(userDataPath)).toEqual([added])
    const backups = readdirSync(userDataPath).filter((name) =>
      name.startsWith('orca-environments.json.corrupt-')
    )
    // The rejected save above left no copy; only the save that replaced the file did.
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(userDataPath, backups[0]))).toEqual(Buffer.alloc(640))
  })

  it('registers a managed SSH server over a NUL-filled store', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-nul-managed-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))

    const added = addManagedOrcadEnvironment(userDataPath, {
      id: 'managed',
      name: 'ssh box',
      pairingCode: pairingCode('ws://127.0.0.1:41000'),
      orcadDeployment: {
        sshTargetId: 'target',
        sshTargetGeneration: 1,
        localPort: 41000,
        remotePort: 6768
      }
    })

    expect(listEnvironments(userDataPath)).toEqual([added])
  })

  it.each([
    ['a newer format', '{"version":2,"environments":[]}'],
    ['truncated JSON that may still hold servers', '{"version":1,"environments":[{"id":"a"']
  ])('does not overwrite %s when a server is saved', (_label, contents) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-invalid-'))
    tempDirs.push(userDataPath)
    writeFileSync(getEnvironmentStorePath(userDataPath), contents)

    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, { name: 'dev box', pairingCode: pairingCode() })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(readdirSync(userDataPath)).toEqual(['orca-environments.json'])
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(contents)
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
        pairingCode: pairingCode('ws://192.0.2.10:6768', undefined, 2)
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })
})
