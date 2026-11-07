import { statSync } from 'node:fs'

// Why: remote RPC, tunnel and worker-server checks resolve the saved-server registry many times per second;
// rereading, rehardening and reparsing three unchanged files each time blocked the Electron main thread.
// A stat signature still sees every write, including ones from the CLI or another Orca process.
const MAX_CACHED_KEYS = 8

function fileSignature(path: string): string {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false })
  return stats
    ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.mode}`
    : '-'
}

export type FileSignatureCache<T> = {
  /** Reuses `read`'s result while none of `paths` changed on disk; a failed read is never cached. */
  read: (key: string, paths: readonly string[], read: () => T) => T
  clear: () => void
}

export function createFileSignatureCache<T>(): FileSignatureCache<T> {
  const cache = new Map<string, { signature: string; value: T }>()
  return {
    read(key, paths, read) {
      const signature = paths.map(fileSignature).join('|')
      const cached = cache.get(key)
      if (cached?.signature === signature) {
        // Callers own their copy; one mutating a result must not leak into the next read.
        return structuredClone(cached.value)
      }
      const value = read()
      cache.delete(key)
      // Re-stat after reading: a write racing the read must not be pinned under the pre-write signature.
      if (paths.map(fileSignature).join('|') === signature) {
        cache.set(key, { signature, value: structuredClone(value) })
        if (cache.size > MAX_CACHED_KEYS) {
          cache.delete(cache.keys().next().value!)
        }
      }
      return value
    },
    clear() {
      cache.clear()
    }
  }
}
