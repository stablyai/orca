import { existsSync, statSync } from 'node:fs'
import { hardenExistingSecureFile } from '../../secure-file'
import { readNodeFileSyncWithinLimit } from '../../node-bounded-file-reader'

// Why: remote RPC, tunnel and worker-server checks resolve the saved-server registry many times per second;
// rechecking, rehardening, reparsing and revalidating unchanged files each time blocked the Electron main thread.
// A cached value is computed from exactly the bytes it is keyed on, so it can never differ from what those
// bytes parse to, however the files or their directory are swapped around the read.
const MAX_CACHED_KEYS = 8
const PROTECTED_FILE_MODE = 0o600
const PROTECTED_DIRECTORY_MODE = 0o700

export type CachedFile = { path: string; maxBytes: number }

type Snapshot = { directoryMode: number | null; files: ({ bytes: Buffer; mode: number } | null)[] }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function snapshot(directory: string, files: readonly CachedFile[]): Snapshot {
  return {
    directoryMode: statSync(directory, { throwIfNoEntry: false })?.mode ?? null,
    files: files.map(({ path, maxBytes }) => {
      try {
        const { buffer, stats } = readNodeFileSyncWithinLimit(path, maxBytes)
        return { bytes: buffer, mode: stats.mode }
      } catch (error) {
        if (isMissing(error)) {
          return null
        }
        throw error
      }
    })
  }
}

function sameBytes(a: Snapshot, b: Snapshot): boolean {
  return a.files.every((file, index) => {
    const other = b.files[index]
    return file && other ? file.bytes.equals(other.bytes) : file === other
  })
}

function samePresence(a: Snapshot, b: Snapshot): boolean {
  return a.files.every((file, index) => (file === null) === (b.files[index] === null))
}

/**
 * Readers re-harden on every read and retry after a failed chmod; reuse is allowed only while the modes they
 * set are visibly in place (POSIX), so any drift or earlier failure is repaired by the next uncached read.
 */
function isProtected(snapshot: Snapshot): boolean {
  // Windows protection lives in ACLs the snapshot cannot see; never claim it is in place.
  if (process.platform === 'win32') {
    return false
  }
  return (
    (snapshot.directoryMode === null ||
      (snapshot.directoryMode & 0o7777) === PROTECTED_DIRECTORY_MODE) &&
    snapshot.files.every((file) => file === null || (file.mode & 0o7777) === PROTECTED_FILE_MODE)
  )
}

export type SecureFileContentCache<T> = {
  /**
   * `compute` parses the given file texts (null = missing). `fallback` is the plain reader; it runs whenever
   * the files cannot be snapshotted or hardened, so errors surface exactly as they did without the cache.
   */
  read: (
    key: string,
    directory: string,
    files: readonly CachedFile[],
    compute: (texts: (string | null)[]) => T,
    fallback: () => T
  ) => T
}

export function createSecureFileContentCache<T>(): SecureFileContentCache<T> {
  const cache = new Map<string, { snapshot: Snapshot; value: T }>()
  return {
    read(key, directory, files, compute, fallback) {
      let current: Snapshot
      try {
        current = snapshot(directory, files)
      } catch {
        cache.delete(key)
        return fallback()
      }
      const cached = cache.get(key)
      if (cached && sameBytes(cached.snapshot, current) && isProtected(current)) {
        // Callers own their copy; one mutating a result must not leak into the next read.
        return structuredClone(cached.value)
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
        read = snapshot(directory, files)
      } catch {
        return fallback()
      }
      if (!samePresence(current, read)) {
        // A file appeared or vanished mid-read; let the plain reader handle that state.
        return fallback()
      }
      const value = compute(read.files.map((file) => file?.bytes.toString('utf8') ?? null))
      if (isProtected(read)) {
        cache.set(key, { snapshot: read, value: structuredClone(value) })
        if (cache.size > MAX_CACHED_KEYS) {
          cache.delete(cache.keys().next().value!)
        }
      }
      return value
    }
  }
}
