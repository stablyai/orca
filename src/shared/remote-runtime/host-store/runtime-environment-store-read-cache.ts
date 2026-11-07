import { lstatSync, statSync, type Stats } from 'node:fs'
import { hardenExistingSecureFile } from '../../secure-file'
import { readNodeFileSyncWithinLimit } from '../../node-bounded-file-reader'

// Why: remote RPC, tunnel and worker-server checks resolve the saved-server registry many times per second;
// rechecking, rehardening, reparsing and revalidating unchanged files each time blocked the Electron main thread.
// Reuse is keyed on the files' exact bytes, so no write (this process, the CLI, another Orca) can be missed.
const MAX_CACHED_KEYS = 8

export type CachedFile = { path: string; maxBytes: number }

type FileSnapshot = {
  bytes: Buffer
  /** The path entry itself: a replaced file or a re-pointed symlink gets a new inode and change time. */
  entry: string
  /** The file read through it: mode is what hardening restricts. */
  mode: number
  ctimeMs: number
} | null
type Snapshot = { directoryEntry: string; directoryMode: number | null; files: FileSnapshot[] }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function entryKey(stats: Stats | undefined): string {
  return stats ? `${stats.dev}:${stats.ino}:${stats.ctimeMs}:${stats.isSymbolicLink()}` : '-'
}

function snapshotFile({ path, maxBytes }: CachedFile): FileSnapshot {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) {
    return null
  }
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, maxBytes)
    return { bytes: buffer, entry: entryKey(entry), mode: stats.mode, ctimeMs: stats.ctimeMs }
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

function snapshot(directory: string, files: readonly CachedFile[]): Snapshot {
  const directoryEntry = lstatSync(directory, { throwIfNoEntry: false })
  return {
    // Only identity, not change time: every write in userData would otherwise defeat reuse.
    directoryEntry: directoryEntry ? `${directoryEntry.dev}:${directoryEntry.ino}` : '-',
    directoryMode: statSync(directory, { throwIfNoEntry: false })?.mode ?? null,
    files: files.map(snapshotFile)
  }
}

function snapshotsMatch(a: Snapshot, b: Snapshot): boolean {
  return (
    a.directoryEntry === b.directoryEntry &&
    a.directoryMode === b.directoryMode &&
    a.files.length === b.files.length &&
    a.files.every((file, index) => {
      const other = b.files[index]
      return file === null || other === null || other === undefined
        ? file === other
        : file.entry === other.entry &&
            file.mode === other.mode &&
            file.ctimeMs === other.ctimeMs &&
            file.bytes.equals(other.bytes)
    })
  )
}

/**
 * The uncached read hardens permissions and retries after a failed chmod. Reuse is allowed only once that
 * protection is visible (POSIX), so a transient failure is retried on the next read exactly as before.
 */
function isProtected(snapshot: Snapshot): boolean {
  if (process.platform === 'win32') {
    return true
  }
  return (
    (snapshot.directoryMode === null || (snapshot.directoryMode & 0o077) === 0) &&
    snapshot.files.every((file) => file === null || (file.mode & 0o077) === 0)
  )
}

export type SecureFileContentCache<T> = {
  /** Reuses `read`'s result while `files` and their directory are unchanged; a failed read is never cached. */
  read: (key: string, directory: string, files: readonly CachedFile[], read: () => T) => T
}

export function createSecureFileContentCache<T>(): SecureFileContentCache<T> {
  const cache = new Map<string, { snapshot: Snapshot; value: T }>()
  return {
    read(key, directory, files, read) {
      let before: Snapshot
      try {
        before = snapshot(directory, files)
      } catch {
        // Unreadable or oversized: the uncached read reports it exactly as before.
        cache.delete(key)
        return read()
      }
      const cached = cache.get(key)
      if (cached && snapshotsMatch(cached.snapshot, before)) {
        if (process.platform === 'win32') {
          // ACLs are invisible in the snapshot; keep the reader's verify-and-retry (with its own backoff).
          for (const [index, file] of files.entries()) {
            if (before.files[index]) {
              hardenExistingSecureFile(file.path)
            }
          }
        }
        // Callers own their copy; one mutating a result must not leak into the next read.
        return structuredClone(cached.value)
      }
      cache.delete(key)
      const value = read()
      let after: Snapshot | null = null
      try {
        after = snapshot(directory, files)
      } catch {
        after = null
      }
      // A write racing the read must not be pinned under the pre-write bytes.
      if (after && snapshotsMatch(before, after) && isProtected(after)) {
        cache.set(key, { snapshot: before, value: structuredClone(value) })
        if (cache.size > MAX_CACHED_KEYS) {
          cache.delete(cache.keys().next().value!)
        }
      }
      return value
    }
  }
}
