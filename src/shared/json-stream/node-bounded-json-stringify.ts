import {
  jsonStringBytes,
  normalizedJsonValue,
  primitiveJsonBytes,
  rawJsonBytes
} from './node-json-utf8-byte-length'

export class JsonStringifyByteLimitError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`JSON output exceeds ${maxBytes} bytes`)
    this.name = 'JsonStringifyByteLimitError'
  }
}

function normalizedJsonIndent(space: number | string | undefined): string {
  if (typeof space === 'number') {
    const width = Number.isNaN(space) || space <= 0 ? 0 : Math.min(10, Math.trunc(space))
    return ' '.repeat(width)
  }
  return typeof space === 'string' ? space.slice(0, 10) : ''
}

export function stringifyJsonWithinByteLimit(
  value: unknown,
  maxBytes: number,
  space?: number | string
): { serialized: string; byteLength: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('JSON byte limit must be a non-negative safe integer')
  }

  let bytes = 0
  let root = true
  const emittedProperties = new WeakMap<object, number>()
  const containerDepths = new WeakMap<object, number>()
  const indent = normalizedJsonIndent(space)
  const indentBytes = Buffer.byteLength(indent, 'utf8')
  const addBytes = (count: number): void => {
    bytes += count
    if (bytes > maxBytes) {
      throw new JsonStringifyByteLimitError(bytes, maxBytes)
    }
  }

  const serialized = JSON.stringify(
    value,
    function (key, rawValue) {
      const normalized = normalizedJsonValue(rawValue, this)
      const isRoot = root
      root = false
      if (normalized === undefined) {
        return undefined
      }

      if (!isRoot) {
        const emitted = emittedProperties.get(this) ?? 0
        const parentDepth = containerDepths.get(this) ?? 0
        if (indentBytes > 0) {
          if (emitted === 0) {
            addBytes(2 + indentBytes * (parentDepth * 2 + 1))
          } else {
            addBytes(2 + indentBytes * (parentDepth + 1))
          }
        } else if (emitted > 0) {
          addBytes(1)
        }
        if (!Array.isArray(this)) {
          addBytes(jsonStringBytes(key) + 1 + (indentBytes > 0 ? 1 : 0))
        }
        emittedProperties.set(this, emitted + 1)
      }

      const encodedBytes = rawJsonBytes(normalized) ?? primitiveJsonBytes(normalized)
      if (encodedBytes !== null) {
        addBytes(encodedBytes)
      } else if (normalized !== null && typeof normalized === 'object') {
        addBytes(2)
        emittedProperties.set(normalized, 0)
        const parentDepth = isRoot ? -1 : (containerDepths.get(this) ?? 0)
        containerDepths.set(normalized, parentDepth + 1)
      }
      return normalized
    },
    space
  )

  if (serialized === undefined) {
    throw new TypeError('JSON value is not serializable')
  }
  const actualBytes = Buffer.byteLength(serialized, 'utf8')
  if (actualBytes > maxBytes) {
    throw new JsonStringifyByteLimitError(actualBytes, maxBytes)
  }
  return { serialized, byteLength: actualBytes }
}
