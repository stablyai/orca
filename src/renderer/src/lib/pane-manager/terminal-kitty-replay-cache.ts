import { z } from 'zod'
import type { Terminal } from '@xterm/xterm'

const uint = z.number().int().min(0).max(0xffffffff)
const grid = z.number().int().min(1).max(65536)
const crop = z.number().int().min(0).max(0xffffffff).optional()
const snapshotSchema = z.object({
  image: z.object({
    id: uint,
    data: z.instanceof(Blob).refine((blob) => blob.size > 0 && blob.size <= 8 * 1024 * 1024),
    width: uint,
    height: uint,
    format: z.union([z.literal(24), z.literal(32), z.literal(100)]),
    compression: z.union([z.literal(''), z.literal('z')]).optional()
  }),
  placements: z
    .array(
      z.object({
        placementId: uint,
        cols: grid,
        rows: grid,
        command: z.object({
          unicodePlaceholder: z.literal(1),
          x: crop,
          y: crop,
          sourceWidth: crop,
          sourceHeight: crop
        })
      })
    )
    .min(1)
    .max(256)
})
export type KittyImageSnapshot = z.infer<typeof snapshotSchema>
const recordSchema = z
  .object({
    scope: z.string().max(4096),
    id: uint,
    touched: z.number().finite(),
    snapshot: snapshotSchema
  })
  .refine((record) => record.id === record.snapshot.image.id)
type ReplayRecord = z.infer<typeof recordSchema>
const metadataSchema = z.object({
  scope: z.string(),
  id: uint,
  touched: z.number().finite(),
  bytes: z.number().int().min(0)
})
type ReplayMetadata = z.infer<typeof metadataSchema>

const DB_NAME = 'orca-terminal-kitty-replay'
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const MAX_BYTES = 128 * 1024 * 1024
const MAX_PANE_BYTES = 32 * 1024 * 1024
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('images', { keyPath: ['scope', 'id'] })
      request.result.createObjectStore('metadata', { keyPath: ['scope', 'id'] })
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        database = undefined
      }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Terminal image cache is blocked'))
  }).catch((error: unknown) => {
    database = undefined
    throw error
  })
  return database
}

export function pruneKittyReplayRecords(
  records: ReplayMetadata[],
  now = Date.now()
): ReplayMetadata[] {
  const removed: ReplayMetadata[] = []
  const panes = new Map<string, number>()
  let total = 0
  let count = 0
  for (const record of [...records].sort((a, b) => b.touched - a.touched)) {
    const bytes = record.bytes
    const paneBytes = panes.get(record.scope) ?? 0
    if (
      now - record.touched > MAX_AGE ||
      count >= 1024 ||
      total + bytes > MAX_BYTES ||
      paneBytes + bytes > MAX_PANE_BYTES
    ) {
      removed.push(record)
    } else {
      total += bytes
      count++
      panes.set(record.scope, paneBytes + bytes)
    }
  }
  return removed
}

export type KittyReplayStore = {
  read(scope: string, id: number): Promise<KittyImageSnapshot | undefined>
  write(changes: { scope: string; id: number; record?: ReplayRecord }[]): Promise<void>
}

export const indexedDbKittyReplayStore: KittyReplayStore = {
  async read(scope, id) {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get([scope, id])
      request.onsuccess = () => {
        const result = recordSchema.safeParse(request.result)
        resolve(
          result.success && Date.now() - result.data.touched <= MAX_AGE
            ? result.data.snapshot
            : undefined
        )
      }
      request.onerror = () => reject(request.error)
    })
  },
  async write(changes) {
    const db = await openDatabase()
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['images', 'metadata'], 'readwrite')
      const images = transaction.objectStore('images')
      const metadata = transaction.objectStore('metadata')
      for (const change of changes) {
        if (change.record) {
          images.put(change.record)
          metadata.put({
            scope: change.scope,
            id: change.id,
            touched: change.record.touched,
            bytes: change.record.snapshot.image.data.size
          })
        } else {
          images.delete([change.scope, change.id])
          metadata.delete([change.scope, change.id])
        }
      }
      const request = metadata.getAll()
      request.onsuccess = () => {
        const records: ReplayMetadata[] = []
        for (const value of request.result) {
          const result = metadataSchema.safeParse(value)
          if (result.success) {
            records.push(result.data)
          }
        }
        for (const record of pruneKittyReplayRecords(records)) {
          images.delete([record.scope, record.id])
          metadata.delete([record.scope, record.id])
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = transaction.onerror = () => reject(transaction.error)
    })
  }
}

export function createKittyReplayCache(store: KittyReplayStore) {
  const changes = new Map<string, { scope: string; id: number; record?: ReplayRecord }>()
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let warned = false
  const warn = (error: unknown) => {
    if (!warned) {
      console.warn('[terminal] image replay cache unavailable', error)
    }
    warned = true
  }
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (changes.size) {
      const batch = [...changes.values()]
      changes.clear()
      pending = pending.then(() => store.write(batch)).catch(warn)
    }
    return pending
  }
  return {
    flush,
    async read(scope: string, id: number) {
      await flush()
      return store.read(scope, id).catch((error: unknown) => {
        warn(error)
        return undefined
      })
    },
    save(scope: string, id: number, snapshot?: KittyImageSnapshot) {
      const parsed = snapshotSchema.safeParse(snapshot)
      const record =
        parsed.success && parsed.data.image.id === id
          ? { scope, id, snapshot: parsed.data, touched: Date.now() }
          : undefined
      changes.set(JSON.stringify([scope, id]), { scope, id, record })
      timer ??= setTimeout(() => {
        void flush()
      }, 100)
    }
  }
}

const cache = createKittyReplayCache(indexedDbKittyReplayStore)
const scopes = new WeakMap<Terminal, string>()
const resets = new WeakMap<Terminal, () => void>()

export function setTerminalKittyReplayScope(terminal: Terminal, scope: string | null): void {
  const previous = scopes.get(terminal)
  if (previous === scope) {
    return
  }
  if (previous) {
    resets.get(terminal)?.()
  }
  if (scope) {
    scopes.set(terminal, scope)
  } else {
    scopes.delete(terminal)
  }
}

export function bindTerminalKittyReplayReset(terminal: Terminal, reset: () => void): () => void {
  resets.set(terminal, reset)
  return () => {
    if (resets.get(terminal) === reset) {
      resets.delete(terminal)
    }
    void cache.flush()
  }
}

export async function readTerminalKittyImage(
  terminal: Terminal,
  id: number
): Promise<KittyImageSnapshot | undefined> {
  const scope = scopes.get(terminal)
  if (!scope) {
    return undefined
  }
  const snapshot = await cache.read(scope, id)
  return scopes.get(terminal) === scope ? snapshot : undefined
}

export function saveTerminalKittyImage(
  terminal: Terminal,
  id: number,
  snapshot?: KittyImageSnapshot
): void {
  const scope = scopes.get(terminal)
  if (scope) {
    cache.save(scope, id, snapshot)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    void cache.flush()
  })
}
