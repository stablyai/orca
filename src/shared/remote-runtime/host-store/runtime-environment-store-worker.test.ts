import './environment-store-worker.test-support'
import { closeEnvironmentStore } from './runtime-environment-store-worker-client'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  markEnvironmentUsed,
  resolveEnvironment
} from './runtime-environment-store'
import {
  getEnvironmentStorePath,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-records'

const roots: string[] = []
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-environment-owner-'))
  roots.push(root)
  return root
}
function pairing(seed: number): string {
  return encodePairingOffer({
    v: 2,
    publicKeyB64: Buffer.alloc(32, seed).toString('base64'),
    deviceToken: `synthetic-device-${seed}`,
    endpoint: `wss://server-${seed}.example.com/runtime`
  })
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('asynchronous environment store owner', () => {
  it('serializes concurrent saves through the production store without replacing another addition', async () => {
    const root = profile()
    await Promise.all([
      addEnvironmentFromPairingCode(root, {
        name: 'Alpha',
        pairingCode: pairing(1),
        now: 100
      }),
      addEnvironmentFromPairingCode(root, {
        name: 'Bravo',
        pairingCode: pairing(2),
        now: 200
      })
    ])
    expect((await listEnvironments(root)).map((environment) => environment.name)).toEqual([
      'Alpha',
      'Bravo'
    ])
  })

  it('observes an older process rewrite before each new read and preserves its unreadable records on save', async () => {
    const root = profile()
    const saved = await addEnvironmentFromPairingCode(root, {
      name: 'Alpha',
      pairingCode: pairing(3),
      now: 100
    })
    expect((await resolveEnvironment(root, saved.id)).name).toBe('Alpha')
    const path = getEnvironmentStorePath(root)
    const store = JSON.parse(readFileSync(path, 'utf8'))
    store.environments[0].name = 'Bravo'
    store.environments.push({ id: 'future-record', kind: 'future', opaque: 'kept' })
    writeFileSync(path, JSON.stringify(store), { mode: 0o600 })
    expect((await resolveEnvironment(root, saved.id)).name).toBe('Bravo')
    await markEnvironmentUsed(root, saved.id, { now: 100_000 })
    expect(JSON.parse(readFileSync(path, 'utf8')).environments).toContainEqual({
      id: 'future-record',
      kind: 'future',
      opaque: 'kept'
    })
  })

  it('keeps pairing failures typed across the worker and isolates returned snapshots', async () => {
    const root = profile()
    const saved = await addEnvironmentFromPairingCode(root, {
      name: 'Alpha',
      pairingCode: pairing(4),
      now: 100
    })
    saved.name = 'Changed by caller'
    saved.endpoints[0]!.deviceToken = 'changed-by-caller'
    const current = await resolveEnvironment(root, saved.id)
    expect(current.name).toBe('Alpha')
    expect(current.endpoints[0]!.deviceToken).toBe('synthetic-device-4')
    await expect(
      addEnvironmentFromPairingCode(root, { name: 'Alpha', pairingCode: pairing(5) })
    ).rejects.toMatchObject({
      name: 'RuntimeEnvironmentStoreError',
      code: 'invalid_argument',
      pairingFailure: { errorCode: 'nameTaken' }
    })
    await expect(resolveEnvironment(root, 'missing')).rejects.toBeInstanceOf(
      RuntimeEnvironmentStoreError
    )
  })
  it('drains an accepted save before closing and refuses later admissions', async () => {
    const root = profile()
    const saved = addEnvironmentFromPairingCode(root, {
      name: 'Final',
      pairingCode: pairing(6),
      now: 100
    })
    const closed = closeEnvironmentStore()
    await expect(listEnvironments(root)).rejects.toThrow('Environment store is closing')
    await saved
    await closed
    expect(
      JSON.parse(readFileSync(getEnvironmentStorePath(root), 'utf8')).environments[0].name
    ).toBe('Final')
  })
})
