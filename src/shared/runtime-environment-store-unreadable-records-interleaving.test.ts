import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  getRuntimeEnvironmentSidecarPath,
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import {
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment
} from './runtime-environment-store'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'
import { readEnvironmentStoreRecords } from './runtime-environment-store-records'
import {
  PersistedRuntimeEnvironmentSchema,
  type PersistedRuntimeEnvironment
} from './runtime-environments'

// Seeded so a failure names a reproducible seed.
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Json = Record<string, unknown>

const StoreFileSchema = z.object({ version: z.literal(1), environments: z.array(z.unknown()) })
const SidecarFileSchema = z.object({ entries: z.record(z.string(), z.unknown()) })

function recordId(record: unknown): unknown {
  return typeof record === 'object' && record !== null && 'id' in record ? record.id : undefined
}

function persisted(id: string, now: number): PersistedRuntimeEnvironment {
  return PersistedRuntimeEnvironmentSchema.parse({
    id,
    name: `name-${id}`,
    createdAt: now,
    updatedAt: now,
    pairingRevision: now,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'wss://server.example/runtime',
        deviceToken: `token-${id}`,
        publicKeyB64: 'a2V5'
      }
    ],
    preferredEndpointId: `ws-${id}`
  })
}

function unreadableRecord(rand: () => number, id: string): unknown {
  const unreadableRecordForms: unknown[] = [
    { ...persisted(id, 1), kind: 'wsl-distro', distro: { name: 'Ubuntu' } },
    { id, name: 'Broken', endpoints: 'not-an-array' },
    { name: 'no id', kind: 'future' },
    'not-an-object',
    null
  ]
  return unreadableRecordForms[Math.floor(rand() * unreadableRecordForms.length)]
}

describe('runtime environment store under interleaved writers and unreadable records', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-interleaving-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const storePath = () => getEnvironmentStorePath(userDataPath)
  const sidecarPath = () => getRuntimeEnvironmentSidecarPath(userDataPath)
  const readStore = () => StoreFileSchema.parse(JSON.parse(readFileSync(storePath(), 'utf8')))
  const sidecarEntries = (): Json => {
    try {
      return SidecarFileSchema.parse(JSON.parse(readFileSync(sidecarPath(), 'utf8'))).entries
    } catch {
      return {}
    }
  }

  function runSeed(seed: number): void {
    const rand = prng(seed)
    const pick = <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(rand() * items.length)]
    let clock = 1_000
    let nextId = 0
    let readable = new Map<string, PersistedRuntimeEnvironment>()
    const unreadable: unknown[] = []
    const unreadableEntries: Json = {}
    const foreignEntries: Json = {}
    const writers: (PersistedRuntimeEnvironment[] | undefined)[] = [undefined, undefined]

    writeFileSync(storePath(), JSON.stringify({ version: 1, environments: [] }))
    const appendRaw = (record: unknown): void => {
      const file = readStore()
      writeFileSync(
        storePath(),
        JSON.stringify({ ...file, environments: [...file.environments, record] })
      )
      unreadable.push(record)
    }
    const writeSidecarRaw = (id: string, value: unknown): void => {
      writeFileSync(
        sidecarPath(),
        JSON.stringify({ version: 1, entries: { ...sidecarEntries(), [id]: value } })
      )
    }

    for (let step = 0; step < 40; step++) {
      clock += 1
      const writer = Math.floor(rand() * writers.length)
      const op = Math.floor(rand() * 9)
      const label = `seed ${seed} step ${step} op ${op}`
      if (op === 0) {
        writers[writer] = readPersistedEnvironmentStore(userDataPath).environments
      } else if (op <= 2 && writers[writer]) {
        // A stale read-modify-write: add, drop, or touch a record from this writer's snapshot.
        let next = [...writers[writer]]
        const kind = Math.floor(rand() * 3)
        if (kind === 0) {
          next.push(persisted(`env-${nextId++}`, clock))
        } else if (kind === 1) {
          const victim = pick(next)
          next = next.filter((entry) => entry !== victim)
        } else {
          next = next.map((entry, index) => (index === 0 ? { ...entry, lastUsedAt: clock } : entry))
        }
        const before = readFileSync(storePath(), 'utf8')
        const ownedElsewhere = next.some(({ id }) =>
          unreadable.some((record) => recordId(record) === id && !readable.has(id))
        )
        if (ownedElsewhere) {
          expect(
            () => writeEnvironmentStore(userDataPath, { version: 1, environments: next }),
            label
          ).toThrow('newer version of Orca')
          expect(readFileSync(storePath(), 'utf8'), label).toBe(before)
        } else {
          writeEnvironmentStore(userDataPath, { version: 1, environments: next })
          readable = new Map(next.map((entry) => [entry.id, entry]))
        }
        writers[writer] = undefined
      } else if (op === 3) {
        appendRaw(unreadableRecord(rand, `future-${nextId++}`))
      } else if (op === 4) {
        // A newer build rewrites a readable record in a format this build cannot read.
        const target = pick([...readable.values()])
        if (target) {
          const file = readStore()
          writeFileSync(
            storePath(),
            JSON.stringify({
              ...file,
              environments: file.environments.filter((entry) => recordId(entry) !== target.id)
            })
          )
          readable.delete(target.id)
          const entry = sidecarEntries()[target.id]
          if (entry !== undefined && !(target.id in unreadableEntries)) {
            foreignEntries[target.id] = entry
          }
          appendRaw({ ...target, kind: 'wsl-distro' })
        }
      } else if (op === 5) {
        const id = pick([...readable.keys(), `orphan-${nextId++}`])!
        const value = { binding: 'newer-shape', sshAccess: { targetFingerprint: `pin-${id}` } }
        writeSidecarRaw(id, value)
        unreadableEntries[id] = value
        delete foreignEntries[id]
      } else if (op === 6) {
        const owner = pick(
          unreadable
            .map(recordId)
            .filter((id): id is string => typeof id === 'string' && !(id in unreadableEntries))
        )
        if (owner) {
          const value = { binding: { createdAt: 1, pairingRevision: 1, preferredEndpointId: 'ws' } }
          writeSidecarRaw(owner, value)
          foreignEntries[owner] = value
        }
      } else {
        const environments = readPersistedEnvironmentStore(userDataPath).environments
        const target = pick(environments)
        if (target && target.id in unreadableEntries) {
          const before = readFileSync(storePath(), 'utf8')
          expect(() => removeEnvironment(userDataPath, target.id), label).toThrow()
          expect(
            () => writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, target, null),
            label
          ).toThrow('newer version of Orca')
          expect(readFileSync(storePath(), 'utf8'), label).toBe(before)
        } else if (target) {
          writeRuntimeEnvironmentSidecarEntry(userDataPath, environments, target, {
            orcadMigratedAt: new Date(clock).toISOString()
          })
        }
      }

      const records = readEnvironmentStoreRecords(userDataPath)
      expect(records.environments.map((entry) => entry.id).sort(), label).toEqual(
        [...readable.keys()].sort()
      )
      expect(new Map(records.environments.map((entry) => [entry.id, entry])), label).toEqual(
        readable
      )
      expect(
        records.unreadable.map((record) => record.raw),
        label
      ).toEqual(unreadable)
      // Never prune unreadable sidecars or sidecars whose owning record is unreadable.
      const entries = sidecarEntries()
      for (const [id, value] of Object.entries({ ...foreignEntries, ...unreadableEntries })) {
        expect(entries[id], `${label} sidecar ${id}`).toEqual(value)
      }
      const listed = new Set(listEnvironments(userDataPath).map((entry) => entry.id))
      for (const [id, environment] of readable) {
        const hidden = id in unreadableEntries
        expect(listed.has(id), `${label} ${id}`).toBe(!hidden)
        if (hidden) {
          expect(() => resolveEnvironment(userDataPath, id), label).toThrow('Unknown environment')
          expect(
            () => readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, environment),
            label
          ).toThrow('newer version of Orca')
        }
      }
    }
  }

  it('never loses, duplicates, or exposes records across random interleavings', () => {
    // Every store write fsyncs, so run only seeds that each break a guard when it is removed:
    // 1 dropped unreadable records, 6 the newer-build id shadow, 8 foreign sidecar owners.
    for (const seed of [1, 6, 8]) {
      rmSync(sidecarPath(), { force: true })
      runSeed(seed)
    }
  })
})
