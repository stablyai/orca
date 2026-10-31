import { z } from 'zod'

const uint = z.number().int().min(0).max(0xffffffff)
const grid = z.number().int().min(1).max(65536)
const crop = z.number().int().min(0).max(0xffffffff).optional()
export const snapshotSchema = z.object({
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
export const MAX_RECORDS = 1024
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
      count >= MAX_RECORDS ||
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

export type ReplayChange = { scope: string; id: number; record?: ReplayRecord }

export type KittyReplayStore = {
  read(scope: string, id: number): Promise<KittyImageSnapshot | undefined>
  write(changes: ReplayChange[]): Promise<void>
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
    // A quota-failed image write must not roll back invalidation of its previous snapshot.
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['images', 'metadata'], 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = transaction.onerror = () => reject(transaction.error)
      for (const { scope, id } of changes) {
        transaction.objectStore('images').delete([scope, id])
        transaction.objectStore('metadata').delete([scope, id])
      }
    })
    if (!changes.some((change) => change.record)) {
      return
    }
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
