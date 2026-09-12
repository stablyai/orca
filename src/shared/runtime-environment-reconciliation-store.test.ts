import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as secureJson from './bounded-secure-json-file'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { readEnvironmentStore, writeEnvironmentStore } from './runtime-environment-store-file'
import {
  cancelPreparedRuntimeEnvironmentReconciliation,
  prepareRuntimeEnvironmentReconciliation
} from './runtime-environment-reconciliation-store'

let directory: string
const offer = {
  v: 2 as const,
  endpoint: 'wss://host.example',
  deviceToken: 'private-grant',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reconciliation-'))
  for (const id of ['left', 'right', 'unrelated']) {
    addEnvironmentFromPairingCode(directory, {
      id,
      name: id,
      pairingCode: encodePairingOffer(offer),
      now: 1
    })
    markEnvironmentUsed(directory, id, { runtimeId: 'host', now: 2 })
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
function argumentsForPreparation() {
  return {
    requestId: 'reconcile',
    canonicalEnvironmentId: 'left',
    verifiedRuntimeId: 'host',
    now: 3,
    expectedRegistrations: listEnvironments(directory).filter((entry) => entry.id !== 'unrelated')
  }
}
function contents() {
  return readFileSync(getEnvironmentStorePath(directory), 'utf8')
}

it('atomically preserves both complete registrations and restores identical evidence after reread', () => {
  const before = listEnvironments(directory)
  const args = argumentsForPreparation()
  const record = prepareRuntimeEnvironmentReconciliation(directory, args)
  const store = readEnvironmentStore(directory)
  expect(store.version).toBe(3)
  expect(store.environments).toEqual(
    before.map((entry) => (entry.id === 'unrelated' ? entry : { ...entry, reconciliation: record }))
  )
  const saved = contents()
  expect(prepareRuntimeEnvironmentReconciliation(directory, { ...args, now: 99 })).toEqual(record)
  expect(contents()).toBe(saved)
})

it.each(['requestId', 'canonicalEnvironmentId', 'verifiedRuntimeId'] as const)(
  'refuses conflicting retry %s without rewriting evidence',
  (field) => {
    const args = argumentsForPreparation()
    prepareRuntimeEnvironmentReconciliation(directory, args)
    const saved = contents()
    expect(() =>
      prepareRuntimeEnvironmentReconciliation(directory, { ...args, [field]: 'different' })
    ).toThrow()
    expect(contents()).toBe(saved)
  }
)

it('rejects stale verified authority before writing', () => {
  const args = argumentsForPreparation()
  updateEnvironmentFromPairingCode(directory, 'right', {
    pairingCode: encodePairingOffer({ ...offer, deviceToken: 'new-grant' })
  })
  const saved = contents()
  expect(() => prepareRuntimeEnvironmentReconciliation(directory, args)).toThrow('changed before')
  expect(contents()).toBe(saved)
})

it.each(['before', 'after'] as const)(
  'recovers a %s-publication write failure without a partial pair',
  (phase) => {
    const args = argumentsForPreparation()
    const saved = contents()
    const original = secureJson.writeSecureJsonFileWithinLimit
    const write = vi
      .spyOn(secureJson, 'writeSecureJsonFileWithinLimit')
      .mockImplementationOnce((...input) => {
        if (phase === 'after') {
          original(...input)
        }
        throw new Error('uncertain publication')
      })
    expect(() => prepareRuntimeEnvironmentReconciliation(directory, args)).toThrow(
      'uncertain publication'
    )
    write.mockRestore()
    if (phase === 'before') {
      expect(contents()).toBe(saved)
    }
    const restored = readEnvironmentStore(directory)
    expect(restored.environments.filter((entry) => entry.reconciliation)).toHaveLength(
      phase === 'before' ? 0 : 2
    )
    const record = prepareRuntimeEnvironmentReconciliation(directory, args)
    expect(
      listEnvironments(directory).filter(
        (entry) => entry.reconciliation?.requestId === record.requestId
      )
    ).toHaveLength(2)
  }
)

it('permits usage freshness and unrelated registrations without dropping historical IDs', () => {
  prepareRuntimeEnvironmentReconciliation(directory, argumentsForPreparation())
  markEnvironmentUsed(directory, 'left', { now: 100_000 })
  removeEnvironment(directory, 'unrelated')
  expect(listEnvironments(directory).map((entry) => entry.id)).toEqual(['left', 'right'])
  expect(readEnvironmentStore(directory).version).toBe(3)
})

it('cancels preparation without changing either registration or its original credentials', () => {
  const write = vi.spyOn(secureJson, 'writeSecureJsonFileWithinLimit')
  const before = listEnvironments(directory)
  prepareRuntimeEnvironmentReconciliation(directory, argumentsForPreparation())
  cancelPreparedRuntimeEnvironmentReconciliation(directory, {
    environmentId: 'right',
    requestId: 'reconcile'
  })
  expect(listEnvironments(directory)).toEqual(before)
  expect(readEnvironmentStore(directory).version).toBe(1)
  expect(write.mock.calls.map((call) => call[3])).toEqual([{ durable: true }, { durable: true }])
})

it('refuses stale cancellation without dropping evidence', () => {
  prepareRuntimeEnvironmentReconciliation(directory, argumentsForPreparation())
  const saved = contents()
  expect(() =>
    cancelPreparedRuntimeEnvironmentReconciliation(directory, {
      environmentId: 'left',
      requestId: 'other-request'
    })
  ).toThrow()
  expect(contents()).toBe(saved)
})

it.each(['remove', 'pairing', 'identity', 'strip-both'])(
  'fences %s changes while reconciliation is prepared',
  (operation) => {
    prepareRuntimeEnvironmentReconciliation(directory, argumentsForPreparation())
    const saved = contents()
    expect(() => {
      if (operation === 'remove') {
        removeEnvironment(directory, 'right')
      }
      if (operation === 'pairing') {
        updateEnvironmentFromPairingCode(directory, 'left', {
          pairingCode: encodePairingOffer(offer)
        })
      }
      if (operation === 'identity') {
        markEnvironmentUsed(directory, 'left', { runtimeId: 'other-host' })
      }
      if (operation === 'strip-both') {
        writeEnvironmentStore(directory, {
          version: 1,
          environments: listEnvironments(directory).map(
            ({ reconciliation: _record, ...entry }) => entry
          )
        })
      }
    }).toThrow()
    expect(contents()).toBe(saved)
  }
)

it.each(['missing-half', 'changed-grant', 'old-version'])(
  'refuses corrupted %s evidence on restart',
  (corruption) => {
    prepareRuntimeEnvironmentReconciliation(directory, argumentsForPreparation())
    const raw = JSON.parse(contents())
    if (corruption === 'missing-half') {
      delete raw.environments[0].reconciliation
    }
    if (corruption === 'changed-grant') {
      raw.environments[0].endpoints[0].deviceToken = 'tampered'
    }
    if (corruption === 'old-version') {
      raw.version = 1
    }
    writeFileSync(getEnvironmentStorePath(directory), JSON.stringify(raw))
    expect(() => readEnvironmentStore(directory)).toThrow('invalid')
  }
)
