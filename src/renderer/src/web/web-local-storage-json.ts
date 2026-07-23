import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from '../../../shared/json-text-structure-limit'
import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'
import {
  stringifyWebRuntimeOutboundJson,
  WebRuntimeOutboundJsonLimitError
} from './web-runtime-outbound-json'

export type WebLocalStorageJsonLimits = JsonTextStructureLimits & {
  maxBytes: number
}

export const WEB_LOCAL_STORAGE_JSON_LIMITS: WebLocalStorageJsonLimits = {
  maxBytes: 8 * 1024 * 1024,
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

export class WebLocalStorageJsonByteCapacityError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Browser-local JSON exceeds ${maxBytes} bytes`)
    this.name = 'WebLocalStorageJsonByteCapacityError'
  }
}

export function parseWebLocalStorageJson<T = unknown>(
  content: string,
  limits: WebLocalStorageJsonLimits = WEB_LOCAL_STORAGE_JSON_LIMITS
): T {
  assertWebLocalStorageJsonBytes(content, limits.maxBytes)
  assertJsonTextStructureWithinLimits(content, limits)
  return JSON.parse(content) as T
}

export function stringifyWebLocalStorageJson(
  value: unknown,
  limits: WebLocalStorageJsonLimits = WEB_LOCAL_STORAGE_JSON_LIMITS
): string {
  let serialized: string | undefined
  try {
    serialized = stringifyWebRuntimeOutboundJson(value, limits.maxBytes).serialized
  } catch (error) {
    if (error instanceof WebRuntimeOutboundJsonLimitError) {
      throw new WebLocalStorageJsonByteCapacityError(limits.maxBytes)
    }
    throw error
  }
  if (serialized === undefined) {
    throw new TypeError('Browser-local JSON value is not serializable')
  }
  assertJsonTextStructureWithinLimits(serialized, limits)
  return serialized
}

function assertWebLocalStorageJsonBytes(content: string, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('Browser-local JSON byte limit must be a positive safe integer')
  }
  if (measureUtf8ByteLength(content, { stopAfterBytes: maxBytes }).exceededLimit) {
    throw new WebLocalStorageJsonByteCapacityError(maxBytes)
  }
}
