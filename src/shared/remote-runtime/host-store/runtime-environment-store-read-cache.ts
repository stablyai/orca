import { readEnvironmentRegistryFile } from './runtime-environment-store-observation'

const MAX_CACHED_KEYS = 8
export type CachedFile = { path: string; maxBytes: number }
export type SecureFileContentCache<T> = {
  read: (
    key: string,
    directory: string,
    files: readonly CachedFile[],
    compute: (texts: (string | null)[]) => T,
    fallback: () => T
  ) => T
}

export function createSecureFileContentCache<T>(): SecureFileContentCache<T> {
  const cache = new Map<string, { bytes: (Buffer | null)[]; value: T }>()
  return {
    read(key, _directory, files, compute, fallback) {
      let bytes: (Buffer | null)[]
      try {
        // Exact observations also run the existing hardening/retry owner before parse reuse.
        bytes = files.map(
          ({ path, maxBytes }) => readEnvironmentRegistryFile(path, maxBytes)?.buffer ?? null
        )
      } catch {
        cache.delete(key)
        return fallback()
      }
      const cached = cache.get(key)
      if (
        cached &&
        bytes.every((file, i) =>
          file && cached.bytes[i] ? file.equals(cached.bytes[i]) : file === cached.bytes[i]
        )
      ) {
        return structuredClone(cached.value)
      }
      cache.delete(key)
      const value = compute(bytes.map((file) => file?.toString('utf8') ?? null))
      cache.set(key, { bytes, value: structuredClone(value) })
      if (cache.size > MAX_CACHED_KEYS) {
        cache.delete(cache.keys().next().value!)
      }
      return value
    }
  }
}
