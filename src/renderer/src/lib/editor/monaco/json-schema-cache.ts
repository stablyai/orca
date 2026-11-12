export const MAX_JSON_SCHEMA_BYTES = 2 * 1024 * 1024
const CACHE_TTL_MS = 10 * 60_000
const MAX_CACHED_SCHEMAS = 32

export function createJsonSchemaCache(
  load: (uri: string, signal: AbortSignal) => Promise<string>,
  remoteEnabled: () => boolean
): { read(uri: string): Promise<string>; clear(): void } {
  const cache = new Map<
    string,
    { expires: number; content: Promise<string>; controller: AbortController }
  >()
  return {
    async read(uri) {
      const remote = /^https?:/i.test(uri)
      if (remote && !remoteEnabled()) {
        throw new Error('Remote JSON schemas are disabled in Settings > General > Editor.')
      }
      const cached = remote ? cache.get(uri) : undefined
      if (cached && cached.expires > Date.now()) {
        return cached.content
      }
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)])
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('JSON schema request cancelled or timed out')),
          { once: true }
        )
      })
      const content = Promise.race([load(uri, signal), aborted]).then((text) => {
        if (new TextEncoder().encode(text).byteLength > MAX_JSON_SCHEMA_BYTES) {
          throw new Error('JSON schema exceeds the 2 MB limit')
        }
        JSON.parse(text)
        return text
      })
      if (remote) {
        cache.delete(uri)
        cache.set(uri, { expires: Date.now() + CACHE_TTL_MS, content, controller })
      }
      while (cache.size > MAX_CACHED_SCHEMAS) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) {
          cache.get(oldest)?.controller.abort()
          cache.delete(oldest)
        }
      }
      try {
        return await content
      } catch (error) {
        if (cache.get(uri)?.content === content) {
          cache.delete(uri)
        }
        throw error
      }
    },
    clear() {
      for (const entry of cache.values()) {
        entry.controller.abort()
      }
      cache.clear()
    }
  }
}

export async function fetchJsonSchema(uri: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(uri, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) {
    throw new Error(`JSON schema request failed (${response.status})`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('JSON schema response has no body')
  }
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      length += value.byteLength
      if (length > MAX_JSON_SCHEMA_BYTES) {
        throw new Error('JSON schema exceeds the 2 MB limit')
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
