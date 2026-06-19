import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed
} from './runtime-environment-store'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
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
})
