import { statSync } from 'node:fs'
import { readNodeFileSyncWithinLimit } from '../../node-bounded-file-reader'

// Why: remote RPC, tunnel and worker-server checks resolve the saved-server registry many times per second;
// rechecking, rehardening, reparsing and revalidating unchanged files each time blocked the Electron main thread.
// Reuse is keyed on the files' exact bytes, so no write (this process, the CLI, another Orca) can be missed.
const MAX_CACHED_KEYS = 8

export type CachedFile = { path: string; maxBytes: number }

type FileSnapshot = { bytes: Buffer; mode: number; ctimeMs: number } | null
type Snapshot = { directoryMode: number | null; files: FileSnapshot[] }

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function snapshotFile({ path, maxBytes }: CachedFile): FileSnapshot {
  try {
    const { buffer, stats } = readNodeFileSyncWithinLimit(path, maxBytes)
    return { bytes: buffer, mode: stats.mode, ctimeMs: stats.ctimeMs }
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

function snapshot(directory: string, files: readonly CachedFile[]): Snapshot {
  return {
    directoryMode: statSync(directory, { throwIfNoEntry: false })?.mode ?? null,
    files: files.map(snapshotFile)
  }
}

// Metadata is compared too: the uncached read re-hardens permissions, so a chmod must not be served from cache.
function snapshotsMatch(a: Snapshot, b: Snapshot): boolean {
  return (
    a.directoryMode === b.directoryMode &&
    a.files.length === b.files.length &&
    a.files.every((file, index) => {
      const other = b.files[index]
      return file === null || other === null || other === undefined
        ? file === other
        : file.mode === other.mode &&
            file.ctimeMs === other.ctimeMs &&
            file.bytes.equals(other.bytes)
    })
  )
}

export type FileContentCache<T> = {
  /** Reuses `read`'s result while `files` and their directory are unchanged; a failed read is never cached. */
  read: (key: string, directory: string, files: readonly CachedFile[], read: () => T) => T
}

export function createFileContentCache<T>(): FileContentCache<T> {
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
      if (after && snapshotsMatch(before, after)) {
        cache.set(key, { snapshot: before, value: structuredClone(value) })
        if (cache.size > MAX_CACHED_KEYS) {
          cache.delete(cache.keys().next().value!)
        }
      }
      return value
    }
  }
}
