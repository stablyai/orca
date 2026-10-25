import { webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryWebDeviceKeyStore, type WebDeviceKeyStore } from './web-device-key-store'
import {
  createWebRuntimeCredentialSource,
  withWebRuntimeAuthPlan,
  type WebRuntimeAuthPlan
} from './web-runtime-credential-source'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's webcrypto implements the SubtleCrypto surface the key helpers call.
const subtle = webcrypto.subtle as unknown as SubtleCrypto

function sourceFor(args: {
  store: WebDeviceKeyStore
  deviceToken: string
  pairingRevision: number
}) {
  const forgetStoredToken = vi.fn()
  const source = createWebRuntimeCredentialSource({
    environment: {
      environmentId: 'env-1',
      hostPublicKeyB64: 'host-key',
      deviceToken: args.deviceToken,
      pairingRevision: args.pairingRevision,
      storage: 'persisted'
    },
    support: 'persistent',
    store: args.store,
    subtle,
    forgetStoredToken,
    forgetPairing: vi.fn()
  })
  return { source, forgetStoredToken }
}

async function migrateOnce(store: WebDeviceKeyStore, pairingRevision: number): Promise<string> {
  const { source } = sourceFor({ store, deviceToken: 'old-code', pairingRevision })
  const plan = await source.nextPlan(true)
  if (plan.kind !== 'migrate') {
    throw new Error(`expected a migration plan, got ${plan.kind}`)
  }
  await source.migrated(plan, 'keyed-1')
  return 'keyed-1'
}

describe('browser credential plans', () => {
  it('a re-pair (new pairing revision) uses its fresh code, not the old key', async () => {
    const store = createMemoryWebDeviceKeyStore()
    await migrateOnce(store, 1)
    const { source } = sourceFor({ store, deviceToken: 'fresh-code', pairingRevision: 2 })
    expect(await source.nextPlan(false)).toEqual({
      kind: 'legacy-token',
      deviceToken: 'fresh-code'
    })
    const plan = await source.nextPlan(true)
    expect(plan).toMatchObject({ kind: 'migrate', deviceToken: 'fresh-code' })
  })

  it('a stale tab never deletes the key of a newer pairing', async () => {
    const store = createMemoryWebDeviceKeyStore()
    await migrateOnce(store, 2)
    const stale = sourceFor({ store, deviceToken: 'old-code', pairingRevision: 1 })
    expect(await stale.source.nextPlan(true)).toEqual({
      kind: 'legacy-token',
      deviceToken: 'old-code'
    })
    expect(await store.get('host-key|env-1')).toMatchObject({ state: 'active', pairingRevision: 2 })
    expect(stale.forgetStoredToken).not.toHaveBeenCalled()
  })

  it('a tab still holding the code forgets it once another tab activated the key', async () => {
    const store = createMemoryWebDeviceKeyStore()
    const deviceId = await migrateOnce(store, 1)
    const tab = sourceFor({ store, deviceToken: 'old-code', pairingRevision: 1 })
    expect(await tab.source.nextPlan(true)).toMatchObject({ kind: 'device-key', deviceId })
    expect(tab.forgetStoredToken).toHaveBeenCalledWith(deviceId)
  })

  it('never reads a broken key store for a code that has not migrated', async () => {
    const broken: WebDeviceKeyStore = {
      get: () => Promise.reject(new Error('IndexedDB unavailable')),
      add: () => Promise.reject(new Error('IndexedDB unavailable')),
      put: () => Promise.reject(new Error('IndexedDB unavailable')),
      remove: () => Promise.reject(new Error('IndexedDB unavailable'))
    }
    const { source } = sourceFor({ store: broken, deviceToken: 'code', pairingRevision: 1 })
    const opened: WebRuntimeAuthPlan[] = []
    const unavailable = vi.fn()
    withWebRuntimeAuthPlan(source, true, (plan) => opened.push(plan), unavailable)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0]).toEqual({ kind: 'legacy-token', deviceToken: 'code' })
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('schedules a retry when a migrated pairing cannot read its key', async () => {
    const broken: WebDeviceKeyStore = {
      ...createMemoryWebDeviceKeyStore(),
      get: () => Promise.reject(new Error('IndexedDB unavailable'))
    }
    const { source } = sourceFor({
      store: broken,
      deviceToken: 'migrated:keyed-1',
      pairingRevision: 1
    })
    const opened: WebRuntimeAuthPlan[] = []
    const unavailable = vi.fn()
    withWebRuntimeAuthPlan(source, true, (plan) => opened.push(plan), unavailable)
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce())
    expect(opened).toEqual([])
  })
})
