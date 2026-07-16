import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed
} from './runtime-environment-store'

function pairingCode(
  endpoint = 'ws://127.0.0.1:6768',
  key = 1,
  deviceToken = 'device-token'
): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken,
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(key)).toString('base64')
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
        pairingCode: pairingCode('ws://192.0.2.10:6768', 2)
      })
    ).toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
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

  it('reuses the pinned host identity on manual re-pair', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const first = addEnvironmentFromPairingCode(userDataPath, {
      name: 'original name',
      pairingCode: pairingCode('ws://127.0.0.1:6768', 1, 'old-token'),
      now: 100
    })

    const second = addEnvironmentFromPairingCode(userDataPath, {
      name: 'new name',
      pairingCode: pairingCode('ws://127.0.0.1:7777', 1, 'new-token'),
      now: 200
    })

    expect(second).toMatchObject({ id: first.id, name: first.name, createdAt: 100, updatedAt: 200 })
    expect(second.endpoints[0]).toMatchObject({
      endpoint: 'ws://127.0.0.1:7777',
      deviceToken: 'new-token'
    })
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('collapses legacy manual duplicates before listing', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const oldest = addEnvironmentFromPairingCode(userDataPath, {
      name: 'oldest',
      pairingCode: pairingCode('ws://127.0.0.1:6768', 1, 'old-token'),
      now: 100
    })
    const raw = JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'))
    const newest = {
      ...oldest,
      id: 'legacy-id',
      name: 'newest',
      createdAt: 200,
      updatedAt: 300,
      lastUsedAt: 200,
      runtimeId: 'new-runtime',
      endpoints: [
        {
          ...oldest.endpoints[0],
          id: 'ws-legacy-id',
          endpoint: 'ws://127.0.0.1:7777',
          deviceToken: 'new-token'
        }
      ],
      preferredEndpointId: 'ws-legacy-id'
    }
    raw.environments = [
      { ...oldest, updatedAt: 400, lastUsedAt: 400, runtimeId: 'old-runtime' },
      newest
    ]
    writeFileSync(getEnvironmentStorePath(userDataPath), JSON.stringify(raw))

    const environments = listEnvironments(userDataPath)
    expect(environments).toHaveLength(1)
    expect(environments[0]).toMatchObject({
      id: oldest.id,
      name: oldest.name,
      createdAt: 100,
      updatedAt: 400,
      lastUsedAt: 400,
      runtimeId: 'old-runtime',
      endpoints: [
        { endpoint: 'ws://127.0.0.1:7777', deviceToken: 'new-token', id: `ws-${oldest.id}` }
      ]
    })
    expect(
      JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).environments
    ).toHaveLength(1)
  })

  it('keeps distinct keys separate even when endpoints match', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'first',
      pairingCode: pairingCode(undefined, 1)
    })
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'second',
      pairingCode: pairingCode(undefined, 2)
    })
    expect(listEnvironments(userDataPath)).toHaveLength(2)
    expect(() =>
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'first',
        pairingCode: pairingCode(undefined, 3)
      })
    ).toThrow('A server named "first" already exists.')
  })

  it('does not reconcile ephemeral VM records into manual hosts', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const manual = addEnvironmentFromPairingCode(userDataPath, {
      name: 'manual',
      pairingCode: pairingCode(undefined, 1)
    })
    const ephemeral = addEnvironmentFromPairingCode(userDataPath, {
      name: 'vm',
      pairingCode: pairingCode(undefined, 1),
      source: 'ephemeral-vm'
    })
    expect(listEnvironments(userDataPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: manual.id }),
        expect.objectContaining({ id: ephemeral.id, source: 'ephemeral-vm' })
      ])
    )
  })

  it('does not rewrite an invalid environment store during reconciliation', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const invalid = '{ invalid json'
    writeFileSync(getEnvironmentStorePath(userDataPath), invalid)
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(invalid)
  })

  it('does not rewrite a schema-invalid environment store during reconciliation', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const invalid = JSON.stringify({ version: 1, environments: [{}] })
    writeFileSync(getEnvironmentStorePath(userDataPath), invalid)
    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
    expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(invalid)
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
})
