import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJsonSchemaCache, fetchJsonSchema, MAX_JSON_SCHEMA_BYTES } from './json-schema-cache'

afterEach(() => vi.unstubAllGlobals())

describe('JSON schema requests', () => {
  it('rereads workspace schemas rather than reuse content after a host change or file edit', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce('{"title":"first"}')
      .mockResolvedValueOnce('{"title":"second"}')
    const cache = createJsonSchemaCache(load, () => true)
    expect(await cache.read('vscode-remote://owner/repo/schema.json')).toContain('first')
    expect(await cache.read('vscode-remote://owner/repo/schema.json')).toContain('second')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('cancels an in-flight request when the cache is cleared', async () => {
    const load = vi.fn(() => new Promise<string>(() => {}))
    const cache = createJsonSchemaCache(load, () => true)
    const request = cache.read('https://example.com/schema')
    cache.clear()
    await expect(request).rejects.toThrow('cancelled')
  })
  it('shares concurrent requests and retries a failed load', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('{}')
    const cache = createJsonSchemaCache(load, () => true)
    await expect(cache.read('https://example.com/schema')).rejects.toThrow('offline')
    await expect(
      Promise.all([
        cache.read('https://example.com/schema'),
        cache.read('https://example.com/schema')
      ])
    ).resolves.toEqual(['{}', '{}'])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('blocks cached and new remote schemas when downloads are disabled, but permits workspace reads', async () => {
    let enabled = true
    const load = vi.fn().mockResolvedValue('{}')
    const cache = createJsonSchemaCache(load, () => enabled)
    await cache.read('https://example.com/schema')
    enabled = false
    await expect(cache.read('https://example.com/schema')).rejects.toThrow('disabled')
    await expect(cache.read('http://example.com/other')).rejects.toThrow('disabled')
    await expect(cache.read('vscode-remote://owner/repo/schema.json')).resolves.toBe('{}')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('bounds the cache and expires entries', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1)
    const load = vi.fn().mockResolvedValue('{}')
    const cache = createJsonSchemaCache(load, () => true)
    for (let index = 0; index < 33; index++) {
      await cache.read(`https://example.com/${index}`)
    }
    await cache.read('https://example.com/0')
    expect(load).toHaveBeenCalledTimes(34)
    now.mockReturnValue(700_000)
    await cache.read('https://example.com/0')
    expect(load).toHaveBeenCalledTimes(35)
    now.mockRestore()
  })

  it('rejects invalid JSON without retaining it', async () => {
    const load = vi.fn().mockResolvedValueOnce('not json').mockResolvedValue('{}')
    const cache = createJsonSchemaCache(load, () => true)
    await expect(cache.read('https://example.com/schema')).rejects.toThrow()
    await expect(cache.read('https://example.com/schema')).resolves.toBe('{}')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('omits credentials and referrers and checks HTTP status', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const signal = AbortSignal.timeout(1_000)
    await expect(fetchJsonSchema('https://example.com/schema', signal)).rejects.toThrow('403')
    expect(fetch).toHaveBeenCalledWith('https://example.com/schema', {
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    })
  })

  it('stops an oversized streamed response without buffering the rest', async () => {
    const cancel = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_JSON_SCHEMA_BYTES + 1))
            },
            cancel
          })
        )
      )
    )
    await expect(
      fetchJsonSchema('https://example.com/schema', AbortSignal.timeout(1_000))
    ).rejects.toThrow('2 MB')
    expect(cancel).toHaveBeenCalledOnce()
  })
})
