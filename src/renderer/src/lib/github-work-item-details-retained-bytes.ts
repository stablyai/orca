import type { GitHubWorkItemDetails } from '../../../shared/types'
import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

const CONTAINER_BYTES = 8
const CONTAINER_ENTRY_BYTES = 8
const CACHE_ENTRY_BYTES = 16

type MeasuredWorkItemDetailsCacheEntry = {
  details: GitHubWorkItemDetails | null
  error?: string
}

type MeasurementFrame =
  | { kind: 'value'; value: unknown }
  | { kind: 'array'; value: readonly unknown[]; index: number }
  | { kind: 'record'; value: Record<string, unknown>; keys: Generator<string> }

function* ownEnumerableKeys(value: Record<string, unknown>): Generator<string> {
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      yield key
    }
  }
}

function addBytes(current: number, additional: number, maxBytes: number): number | null {
  const next = current + additional
  return next <= maxBytes ? next : null
}

function addStringBytes(current: number, value: string, maxBytes: number): number | null {
  const measured = measureUtf8ByteLength(value, {
    stopAfterBytes: Math.max(0, maxBytes - current)
  })
  if (measured.exceededLimit) {
    return null
  }
  return addBytes(current, measured.byteLength, maxBytes)
}

function measureRetainedValue(value: unknown, maxBytes: number, initialBytes = 0): number | null {
  const seen = new WeakSet<object>()
  const frames: MeasurementFrame[] = [{ kind: 'value', value }]
  let bytes = initialBytes
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
      const withEntry = addBytes(bytes, CONTAINER_ENTRY_BYTES, maxBytes)
      const withKey = withEntry === null ? null : addStringBytes(withEntry, nextKey.value, maxBytes)
      if (withKey === null) {
        return null
      }
      bytes = withKey
      frames.push(frame)
      frames.push({ kind: 'value', value: frame.value[nextKey.value] })
      continue
    }

    const current = frame.value
    if (current === null || current === undefined) {
      continue
    }
    if (typeof current === 'string') {
      const measured = addStringBytes(bytes, current, maxBytes)
      if (measured === null) {
        return null
      }
      bytes = measured
      continue
    }
    if (typeof current === 'number' || typeof current === 'boolean') {
      const measured = addBytes(bytes, typeof current === 'number' ? 8 : 1, maxBytes)
      if (measured === null) {
        return null
      }
      bytes = measured
      continue
    }
    if (typeof current !== 'object' || seen.has(current)) {
      if (typeof current !== 'object') {
        return null
      }
      continue
    }

    seen.add(current)
    const withContainer = addBytes(bytes, CONTAINER_BYTES, maxBytes)
    if (withContainer === null) {
      return null
    }
    bytes = withContainer
    if (Array.isArray(current)) {
      const withEntries = addBytes(bytes, current.length * CONTAINER_ENTRY_BYTES, maxBytes)
      if (withEntries === null) {
        return null
      }
      bytes = withEntries
      frames.push({ kind: 'array', value: current, index: 0 })
      continue
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      return null
    }
    const record = current as Record<string, unknown>
    frames.push({ kind: 'record', value: record, keys: ownEnumerableKeys(record) })
  }
  return bytes
}

export function measureWorkItemDetailsCacheEntryBytes(
  entry: MeasuredWorkItemDetailsCacheEntry,
  maxBytes: number
): number | null {
  const detailsBytes = measureRetainedValue(entry.details, maxBytes, CACHE_ENTRY_BYTES)
  if (detailsBytes === null || !entry.error) {
    return detailsBytes
  }
  return addStringBytes(detailsBytes, entry.error, maxBytes)
}
