import { measureUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

export const NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX = 128
export const NATIVE_CHAT_SCOPE_CACHE_MAX_AGGREGATE_BYTES = 32 * 1024 * 1024
export const NATIVE_CHAT_SCOPE_CACHE_MAX_VALUE_BYTES = 16 * 1024 * 1024
export const NATIVE_CHAT_SCOPE_CACHE_MAX_KEY_BYTES = 4 * 1024

const CONTAINER_BYTES = 8
const CONTAINER_ENTRY_BYTES = 8

export type NativeChatScopeCacheLimits = {
  maxEntriesPerCache: number
  maxAggregateBytes: number
  maxValueBytes: number
  maxKeyBytes: number
}

export type NativeChatScopeCacheController = {
  set<T>(cache: Map<string, T>, scopeKey: string, value: T): boolean
  get<T>(cache: Map<string, T>, scopeKey: string): T | undefined
  delete<T>(cache: Map<string, T>, scopeKey: string): boolean
  clear<T>(cache: Map<string, T>): void
  getRetainedBytes(): number
}

type RetainedEntry = {
  cacheIdentity: object
  scopeKey: string
  retainedBytes: number
  deleteCachedValue: () => void
}

type MeasurementFrame =
  | { kind: 'value'; value: unknown }
  | { kind: 'array'; value: readonly unknown[]; index: number }
  | {
      kind: 'record'
      value: Record<string, unknown>
      keys: Generator<string, void, unknown>
    }

const DEFAULT_LIMITS: NativeChatScopeCacheLimits = {
  maxEntriesPerCache: NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  maxAggregateBytes: NATIVE_CHAT_SCOPE_CACHE_MAX_AGGREGATE_BYTES,
  maxValueBytes: NATIVE_CHAT_SCOPE_CACHE_MAX_VALUE_BYTES,
  maxKeyBytes: NATIVE_CHAT_SCOPE_CACHE_MAX_KEY_BYTES
}

function addMeasuredBytes(
  currentBytes: number,
  additionalBytes: number,
  maxBytes: number
): { bytes: number; exceeded: boolean } {
  const bytes = currentBytes + additionalBytes
  return { bytes, exceeded: bytes > maxBytes }
}

function measureRetainedString(
  value: string,
  currentBytes: number,
  maxBytes: number
): { bytes: number; exceeded: boolean } {
  const remaining = Math.max(0, maxBytes - currentBytes)
  const measured = measureUtf8ByteLength(value, { stopAfterBytes: remaining })
  const next = addMeasuredBytes(currentBytes, measured.byteLength, maxBytes)
  return { bytes: next.bytes, exceeded: measured.exceededLimit || next.exceeded }
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function* iterateOwnEnumerableKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      yield key
    }
  }
}

function measureRetainedValue(value: unknown, maxBytes: number): number | null {
  const seen = new WeakSet<object>()
  const frames: MeasurementFrame[] = [{ kind: 'value', value }]
  let bytes = 0

  while (frames.length > 0) {
    const frame = frames.pop()
    if (!frame) {
      break
    }
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) {
        continue
      }
      const index = frame.index
      frame.index += 1
      frames.push(frame)
      if (Object.hasOwn(frame.value, index)) {
        frames.push({ kind: 'value', value: frame.value[index] })
      }
      continue
    }
    if (frame.kind === 'record') {
      const nextKey = frame.keys.next()
      if (nextKey.done) {
        continue
      }
      const entry = addMeasuredBytes(bytes, CONTAINER_ENTRY_BYTES, maxBytes)
      if (entry.exceeded) {
        return null
      }
      const keyMeasurement = measureRetainedString(nextKey.value, entry.bytes, maxBytes)
      if (keyMeasurement.exceeded) {
        return null
      }
      bytes = keyMeasurement.bytes
      frames.push(frame)
      frames.push({ kind: 'value', value: frame.value[nextKey.value] })
      continue
    }

    const current = frame.value
    if (current === null || current === undefined) {
      continue
    }
    if (typeof current === 'string') {
      const measured = measureRetainedString(current, bytes, maxBytes)
      if (measured.exceeded) {
        return null
      }
      bytes = measured.bytes
      continue
    }
    if (typeof current === 'number') {
      const measured = addMeasuredBytes(bytes, 8, maxBytes)
      if (measured.exceeded) {
        return null
      }
      bytes = measured.bytes
      continue
    }
    if (typeof current === 'boolean') {
      const measured = addMeasuredBytes(bytes, 1, maxBytes)
      if (measured.exceeded) {
        return null
      }
      bytes = measured.bytes
      continue
    }
    if (typeof current !== 'object' || seen.has(current)) {
      if (typeof current !== 'object') {
        return null
      }
      continue
    }

    seen.add(current)
    const container = addMeasuredBytes(bytes, CONTAINER_BYTES, maxBytes)
    if (container.exceeded) {
      return null
    }
    bytes = container.bytes
    if (Array.isArray(current)) {
      const entries = addMeasuredBytes(bytes, current.length * CONTAINER_ENTRY_BYTES, maxBytes)
      if (entries.exceeded) {
        return null
      }
      bytes = entries.bytes
      frames.push({ kind: 'array', value: current, index: 0 })
      continue
    }
    if (!isPlainRecord(current)) {
      return null
    }
    frames.push({ kind: 'record', value: current, keys: iterateOwnEnumerableKeys(current) })
  }

  return bytes
}

export function createNativeChatScopeCacheController(
  limitOverrides: Partial<NativeChatScopeCacheLimits> = {}
): NativeChatScopeCacheController {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides }
  const entriesByCache = new Map<object, Map<string, RetainedEntry>>()
  const globalLru = new Map<RetainedEntry, true>()
  let retainedBytes = 0

  const removeEntry = (entry: RetainedEntry, deleteCachedValue: boolean): void => {
    const cacheEntries = entriesByCache.get(entry.cacheIdentity)
    cacheEntries?.delete(entry.scopeKey)
    if (cacheEntries?.size === 0) {
      entriesByCache.delete(entry.cacheIdentity)
    }
    if (globalLru.delete(entry)) {
      retainedBytes -= entry.retainedBytes
    }
    if (deleteCachedValue) {
      entry.deleteCachedValue()
    }
  }

  const evictOldest = (entries: Map<RetainedEntry, true>): void => {
    const oldest = entries.keys().next().value
    if (oldest) {
      removeEntry(oldest, true)
    }
  }

  const controller: NativeChatScopeCacheController = {
    set: <T>(cache: Map<string, T>, scopeKey: string, value: T): boolean => {
      controller.delete(cache, scopeKey)
      const keyMeasurement = measureUtf8ByteLength(scopeKey, {
        stopAfterBytes: limits.maxKeyBytes
      })
      if (keyMeasurement.exceededLimit) {
        return false
      }
      const valueBytes = measureRetainedValue(value, limits.maxValueBytes)
      if (valueBytes === null) {
        return false
      }
      const entryBytes = keyMeasurement.byteLength + valueBytes
      if (entryBytes > limits.maxAggregateBytes) {
        return false
      }

      cache.set(scopeKey, value)
      const cacheIdentity = cache as object
      const cacheEntries = entriesByCache.get(cacheIdentity) ?? new Map()
      entriesByCache.set(cacheIdentity, cacheEntries)
      const entry: RetainedEntry = {
        cacheIdentity,
        scopeKey,
        retainedBytes: entryBytes,
        deleteCachedValue: () => {
          cache.delete(scopeKey)
        }
      }
      cacheEntries.set(scopeKey, entry)
      globalLru.set(entry, true)
      retainedBytes += entryBytes

      while (cacheEntries.size > limits.maxEntriesPerCache) {
        const oldest = cacheEntries.values().next().value
        if (!oldest) {
          break
        }
        removeEntry(oldest, true)
      }
      while (retainedBytes > limits.maxAggregateBytes) {
        evictOldest(globalLru)
      }
      return cacheEntries.get(scopeKey) === entry
    },
    get: <T>(cache: Map<string, T>, scopeKey: string): T | undefined => {
      const cacheEntries = entriesByCache.get(cache as object)
      const entry = cacheEntries?.get(scopeKey)
      if (!entry) {
        return cache.get(scopeKey)
      }
      if (!cache.has(scopeKey)) {
        removeEntry(entry, false)
        return undefined
      }
      const value = cache.get(scopeKey)
      cache.delete(scopeKey)
      cache.set(scopeKey, value as T)
      cacheEntries?.delete(scopeKey)
      cacheEntries?.set(scopeKey, entry)
      globalLru.delete(entry)
      globalLru.set(entry, true)
      return value
    },
    delete: <T>(cache: Map<string, T>, scopeKey: string): boolean => {
      const entry = entriesByCache.get(cache as object)?.get(scopeKey)
      if (!entry) {
        return cache.delete(scopeKey)
      }
      const hadValue = cache.has(scopeKey)
      removeEntry(entry, true)
      return hadValue
    },
    clear: <T>(cache: Map<string, T>): void => {
      const cacheEntries = entriesByCache.get(cache as object)
      if (cacheEntries) {
        for (const entry of cacheEntries.values()) {
          removeEntry(entry, false)
        }
      }
      cache.clear()
    },
    getRetainedBytes: () => retainedBytes
  }
  return controller
}

const sharedController = createNativeChatScopeCacheController()

export function setBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string,
  value: T
): boolean {
  return sharedController.set(cache, scopeKey, value)
}

export function getBoundedScopeCacheEntry<T>(
  cache: Map<string, T>,
  scopeKey: string
): T | undefined {
  return sharedController.get(cache, scopeKey)
}

export function deleteBoundedScopeCacheEntry<T>(cache: Map<string, T>, scopeKey: string): boolean {
  return sharedController.delete(cache, scopeKey)
}

export function clearBoundedScopeCache<T>(cache: Map<string, T>): void {
  sharedController.clear(cache)
}
