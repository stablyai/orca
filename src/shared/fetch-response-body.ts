import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from './json-text-structure-limit'

const INITIAL_RESPONSE_CAPACITY_BYTES = 64 * 1024

export const API_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
export const API_RESPONSE_JSON_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

export class FetchResponseBodyTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`Response body exceeds ${maxBytes} byte limit`)
    this.name = 'FetchResponseBodyTooLargeError'
  }
}

function parseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw)) {
    return null
  }
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function isHighLevelOnlyResponse(response: Response): boolean {
  const partial = response as Partial<Response>
  // Injected request adapters may expose only the high-level method they implement.
  return partial.headers === undefined && partial.body === undefined
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // An already-errored or closed response needs no further draining.
  }
}

export async function readFetchResponseBytesWithinLimit(
  response: Response,
  maxBytes = API_RESPONSE_MAX_BYTES
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Response body limit must be a non-negative safe integer')
  }

  const contentLength = parseContentLength(response)
  if (contentLength !== null && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new FetchResponseBodyTooLargeError(contentLength, maxBytes)
  }
  if (!response.body) {
    return new Uint8Array()
  }

  const reader = response.body.getReader()
  let output = new Uint8Array(Math.min(maxBytes, INITIAL_RESPONSE_CAPACITY_BYTES))
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return output.subarray(0, byteLength)
      }
      const nextLength = byteLength + value.byteLength
      if (!Number.isSafeInteger(nextLength) || nextLength > maxBytes) {
        await cancelReader(reader)
        throw new FetchResponseBodyTooLargeError(nextLength, maxBytes)
      }
      if (nextLength > output.byteLength) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(INITIAL_RESPONSE_CAPACITY_BYTES, output.byteLength * 2, nextLength)
        )
        const expanded = new Uint8Array(nextCapacity)
        expanded.set(output.subarray(0, byteLength))
        output = expanded
      }
      output.set(value, byteLength)
      byteLength = nextLength
    }
  } finally {
    reader.releaseLock()
  }
}

export async function readFetchResponseTextWithinLimit(
  response: Response,
  maxBytes = API_RESPONSE_MAX_BYTES
): Promise<string> {
  if (isHighLevelOnlyResponse(response)) {
    return response.text()
  }
  return new TextDecoder().decode(await readFetchResponseBytesWithinLimit(response, maxBytes))
}

export async function readFetchResponseJsonWithinLimit<T>(
  response: Response,
  maxBytes = API_RESPONSE_MAX_BYTES,
  structureLimits: JsonTextStructureLimits = API_RESPONSE_JSON_LIMITS
): Promise<T> {
  if (isHighLevelOnlyResponse(response)) {
    return response.json() as Promise<T>
  }
  const content = await readFetchResponseTextWithinLimit(response, maxBytes)
  assertJsonTextStructureWithinLimits(content, structureLimits)
  return JSON.parse(content) as T
}
