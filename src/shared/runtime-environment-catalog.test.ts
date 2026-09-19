import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as secureJson from './bounded-secure-json-file'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  resolveEnvironment
} from './runtime-environment-store'
import { readEnvironmentStore, writeEnvironmentStore } from './runtime-environment-store-file'
import {
  prepareRuntimeEnvironmentReconciliation,
  cancelPreparedRuntimeEnvironmentReconciliation
} from './runtime-environment-reconciliation-store'
import { setRuntimeEnvironmentReconciliationCatalogActive } from './runtime-environment-reconciliation-catalog'
import {
  listRuntimeEnvironmentCatalog,
  resolveRuntimeEnvironmentCatalogEntry
} from './runtime-environment-catalog'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-canonical-catalog-'))
  for (const id of ['canonical', 'historical', 'unrelated']) {
    addEnvironmentFromPairingCode(directory, {
      id,
      name: `Name ${id}`,
      now: 1,
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: `wss://${id}.example`,
        publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
        deviceToken: `grant-${id}`
      })
    })
  }
  prepareRuntimeEnvironmentReconciliation(directory, {
    requestId: 'reconcile',
    canonicalEnvironmentId: 'canonical',
    verifiedRuntimeId: 'host',
    expectedRegistrations: listEnvironments(directory).filter((entry) => entry.id !== 'unrelated')
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const transition = (active = true) =>
  setRuntimeEnvironmentReconciliationCatalogActive(directory, {
    environmentId: 'historical',
    requestId: 'reconcile',
    active
  })
const contents = () => readFileSync(getEnvironmentStorePath(directory), 'utf8')

it('does not collapse prepared registrations before explicit catalog activation', () => {
  expect(listRuntimeEnvironmentCatalog(directory)).toHaveLength(3)
  expect(resolveRuntimeEnvironmentCatalogEntry(directory, 'historical').environment.id).toBe(
    'historical'
  )
})

it('publishes one canonical catalog entry while preserving historical lookup, grants and storage ownership', () => {
  const original = resolveEnvironment(directory, 'historical')
  transition()
  expect(readEnvironmentStore(directory).version).toBe(4)
  expect(
    listRuntimeEnvironmentCatalog(directory).map((entry) => ({
      id: entry.environment.id,
      aliases: entry.historicalEnvironmentIds
    }))
  ).toEqual([
    { id: 'canonical', aliases: ['historical'] },
    { id: 'unrelated', aliases: [] }
  ])
  expect(listEnvironments(directory).map((entry) => entry.id)).toEqual([
    'canonical',
    'historical',
    'unrelated'
  ])
  expect(resolveEnvironment(directory, 'historical').endpoints).toEqual(original.endpoints)
  expect(resolveEnvironment(directory, 'historical').id).toBe('historical')
  expect(resolveRuntimeEnvironmentCatalogEntry(directory, 'Name historical')).toMatchObject({
    requestedEnvironmentId: 'historical',
    environment: { id: 'canonical' }
  })
})

it('retries and reverses catalog activation without rewriting either grant', () => {
  const before = listEnvironments(directory)
  const active = transition()
  const saved = contents()
  expect(transition()).toEqual(active)
  expect(contents()).toBe(saved)
  transition(false)
  expect(listEnvironments(directory)).toEqual(before)
  expect(listRuntimeEnvironmentCatalog(directory)).toHaveLength(3)
  cancelPreparedRuntimeEnvironmentReconciliation(directory, {
    environmentId: 'canonical',
    requestId: 'reconcile'
  })
  expect(readEnvironmentStore(directory).version).toBe(1)
})

it('does not let preparation cancellation bypass active-catalog rollback', () => {
  transition()
  const saved = contents()
  expect(() =>
    cancelPreparedRuntimeEnvironmentReconciliation(directory, {
      environmentId: 'canonical',
      requestId: 'reconcile'
    })
  ).toThrow()
  expect(contents()).toBe(saved)
})

it('rejects stale transition requests and unprivileged stage edits', () => {
  const saved = contents()
  expect(() =>
    setRuntimeEnvironmentReconciliationCatalogActive(directory, {
      environmentId: 'canonical',
      requestId: 'wrong',
      active: true
    })
  ).toThrow()
  const store = readEnvironmentStore(directory)
  for (const environment of store.environments) {
    if (environment.reconciliation) {
      environment.reconciliation.stage = 'catalog-active'
    }
  }
  expect(() => writeEnvironmentStore(directory, store)).toThrow()
  expect(contents()).toBe(saved)
})

it('does not infer aliases from matching runtime IDs or names', () => {
  transition()
  expect(resolveRuntimeEnvironmentCatalogEntry(directory, 'unrelated').environment.id).toBe(
    'unrelated'
  )
  expect(() => resolveRuntimeEnvironmentCatalogEntry(directory, 'host')).toThrow(
    'Unknown environment'
  )
})

it('refuses catalog-active evidence stored with the preparation-only version', () => {
  transition()
  const raw = JSON.parse(contents())
  raw.version = 3
  writeFileSync(getEnvironmentStorePath(directory), JSON.stringify(raw))
  expect(() => listRuntimeEnvironmentCatalog(directory)).toThrow('invalid')
})

it.each(['before', 'after'] as const)(
  'recovers a %s-publication catalog write failure',
  (phase) => {
    const original = secureJson.writeSecureJsonFileWithinLimit
    const write = vi
      .spyOn(secureJson, 'writeSecureJsonFileWithinLimit')
      .mockImplementationOnce((...args) => {
        if (phase === 'after') {
          original(...args)
        }
        throw new Error('publication uncertain')
      })
    expect(() => transition()).toThrow('publication uncertain')
    write.mockRestore()
    expect(listRuntimeEnvironmentCatalog(directory)).toHaveLength(phase === 'before' ? 3 : 2)
    expect(listEnvironments(directory)).toHaveLength(3)
    transition()
    expect(listRuntimeEnvironmentCatalog(directory)).toHaveLength(2)
  }
)
