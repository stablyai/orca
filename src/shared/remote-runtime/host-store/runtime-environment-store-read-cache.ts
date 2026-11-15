import { existsSync, statSync, type Stats } from 'node:fs'
import { hardenExistingSecureFile } from '../../secure-storage/secure-file'
import { readNodeFileSyncWithinLimit } from '../../file-content/node-bounded-file-reader'

// Why: remote RPC, tunnel and worker-server checks resolve the saved-server registry many times per second;
// rechecking, rehardening, reparsing and revalidating unchanged files each time blocked the Electron main thread.
// A cached value is computed from exactly the bytes it is keyed on, so it can never differ from what those
// bytes parse to, however the files or their directory are swapped around the read.
const MAX_CACHED_KEYS = 8
const PROTECTED_FILE_MODE = 0o600
const PROTECTED_DIRECTORY_MODE = 0o700
// Why: a rewrite within timestamp granularity can keep size, inode and times (racy git), so
// metadata vouches for bytes only once they were read this long after their last change (FAT: 2 s).
const TIMESTAMP_GRANULARITY_MS = 3_000
// Why: settling trusts the wall clock to move forward; after it steps back a rewrite can reuse
// cached timestamps, so hits compare bytes again until a read made on the new clock settles.
const CLOCK_STEP_TOLERANCE_MS = 1_000

export type CachedFile = { path: string; maxBytes: number }

type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs' | 'mode'>

type Snapshot = {
  directoryMode: number | null
  files: ({ bytes: Buffer; stats: FileIdentity } | null)[]
}

type MetadataSnapshot = { directoryMode: number | null; files: (FileIdentity | null)[] }

type ReadClock = { wall: number; monotonic: number }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function statIfPresent(path: string): Stats | null {
  return statSync(path, { throwIfNoEntry: false }) ?? null
}

function snapshot(directory: string, files: readonly CachedFile[]): Snapshot {
  return {
    directoryMode: statIfPresent(directory)?.mode ?? null,
    files: files.map(({ path, maxBytes }) => {
      try {
        const { buffer, stats } = readNodeFileSyncWithinLimit(path, maxBytes)
        return { bytes: buffer, stats }
      } catch (error) {
        if (isMissing(error)) {
          return null
        }
        throw error
      }
    })
  }
}

function metadataSnapshot(directory: string, files: readonly CachedFile[]): MetadataSnapshot {
  return {
    directoryMode: statIfPresent(directory)?.mode ?? null,
    files: files.map(({ path }) => statIfPresent(path))
  }
}

function sameBytes(a: Snapshot, b: Snapshot): boolean {
  return a.files.every((file, index) => {
    const other = b.files[index]
    return file && other ? file.bytes.equals(other.bytes) : file === other
  })
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode
  )
}

function metadataOf(snapshot: Snapshot): MetadataSnapshot {
  return {
    directoryMode: snapshot.directoryMode,
    files: snapshot.files.map((file) => file?.stats ?? null)
  }
}

function sameMetadata(a: MetadataSnapshot, b: MetadataSnapshot): boolean {
  return a.files.every((file, index) => {
    const other = b.files[index]
    return file && other ? sameIdentity(file, other) : file === other
  })
}

function samePresence(a: Snapshot, b: Snapshot): boolean {
  return a.files.every((file, index) => (file === null) === (b.files[index] === null))
}

function readClock(): ReadClock {
  return { wall: Date.now(), monotonic: performance.now() }
}

function readLongAfterLastChange(snapshot: Snapshot, readAt: ReadClock): boolean {
  return snapshot.files.every(
    (file) =>
      file === null ||
      readAt.wall - Math.max(file.stats.mtimeMs, file.stats.ctimeMs) >= TIMESTAMP_GRANULARITY_MS
  )
}

function clockSteppedBackSince(readAt: ReadClock): boolean {
  return Date.now() - readAt.wall < performance.now() - readAt.monotonic - CLOCK_STEP_TOLERANCE_MS
}

/**
 * Readers re-harden on every read and retry after a failed chmod; reuse is allowed only while the modes they
 * set are visibly in place (POSIX), so any drift or earlier failure is repaired by the next uncached read.
 */
function isProtected({ directoryMode, files }: MetadataSnapshot): boolean {
  // Windows protection lives in ACLs the snapshot cannot see; never claim it is in place.
  if (process.platform === 'win32') {
    return false
  }
  return (
    (directoryMode === null || (directoryMode & 0o7777) === PROTECTED_DIRECTORY_MODE) &&
    files.every((file) => file === null || (file.mode & 0o7777) === PROTECTED_FILE_MODE)
  )
}

export type SecureFileContentCache<T> = {
  /**
   * `compute` parses the given file texts (null = missing). `fallback` is the plain reader; it runs whenever
   * the files cannot be snapshotted or hardened, so errors surface exactly as they did without the cache.
   * A hit returns the cached value itself, so callers must never mutate it.
   */
  read: (
    key: string,
    directory: string,
    files: readonly CachedFile[],
    compute: (texts: (string | null)[]) => T,
    fallback: () => T
  ) => T
}

type CacheEntry<T> = { snapshot: Snapshot; value: T; readAt: ReadClock; settled: boolean }

export function createSecureFileContentCache<T>(): SecureFileContentCache<T> {
  const cache = new Map<string, CacheEntry<T>>()
  const remember = (key: string, entry: CacheEntry<T>): void => {
    cache.delete(key)
    cache.set(key, entry)
    if (cache.size > MAX_CACHED_KEYS) {
      cache.delete(cache.keys().next().value!)
    }
  }
  return {
    read(key, directory, files, compute, fallback) {
      const cached = cache.get(key)
      if (cached?.settled && !clockSteppedBackSince(cached.readAt)) {
        let metadata: MetadataSnapshot
        try {
          metadata = metadataSnapshot(directory, files)
        } catch {
          cache.delete(key)
          return fallback()
        }
        if (sameMetadata(metadataOf(cached.snapshot), metadata) && isProtected(metadata)) {
          return cached.value
        }
      }
      let current: Snapshot
      let readAt = readClock()
      try {
        current = snapshot(directory, files)
      } catch {
        cache.delete(key)
        return fallback()
      }
      if (cached && sameBytes(cached.snapshot, current) && isProtected(metadataOf(current))) {
        remember(key, {
          snapshot: current,
          value: cached.value,
          readAt,
          settled: readLongAfterLastChange(current, readAt)
        })
        return cached.value
      }
      cache.delete(key)
      let read: Snapshot
      try {
        // Same hardening the readers do before reading a present file.
        for (const file of files) {
          if (existsSync(file.path)) {
            hardenExistingSecureFile(file.path)
          }
        }
        readAt = readClock()
        read = snapshot(directory, files)
      } catch {
        return fallback()
      }
      if (!samePresence(current, read)) {
        // A file appeared or vanished mid-read; let the plain reader handle that state.
        return fallback()
      }
      const value = compute(read.files.map((file) => file?.bytes.toString('utf8') ?? null))
      if (isProtected(metadataOf(read))) {
        remember(key, {
          snapshot: read,
          value,
          readAt,
          settled: readLongAfterLastChange(read, readAt)
        })
      }
      return value
    }
  }
}
