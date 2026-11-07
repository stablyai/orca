import { describe, expect, it } from 'vitest'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

describe('createHoverPreviewCache', () => {
  it('drops the oldest answers once their total size passes the budget', async () => {
    const cache = createHoverPreviewCache<string>({
      freshMs: 60_000,
      maxEntries: 100,
      budget: { maxBytes: 10, sizeOf: (value) => value.length }
    })
    await cache.load('a', async () => 'aaaa')
    await cache.load('b', async () => 'bbbb')
    await cache.load('c', async () => 'cccc')

    expect(cache.read('a')).toBeNull()
    expect(cache.read('b')).toBe('bbbb')
    expect(cache.read('c')).toBe('cccc')
  })

  it('stays within the budget when an older request finishes last', async () => {
    const cache = createHoverPreviewCache<string>({
      freshMs: 60_000,
      maxEntries: 100,
      budget: { maxBytes: 10, sizeOf: (value) => value.length }
    })
    let finishSlow: (value: string) => void = () => {}
    const slow = cache.load('slow', () => new Promise((resolve) => (finishSlow = resolve)))
    await cache.load('b', async () => 'bbbb')
    await cache.load('c', async () => 'cccc')
    finishSlow('ssss')
    await slow

    expect(cache.read('slow')).toBe('ssss')
    expect(cache.read('b')).toBeNull()
    expect(cache.read('c')).toBe('cccc')
  })

  it('keeps the last answer through a reread that fails, and rereads past one started earlier', async () => {
    const cache = createHoverPreviewCache<string>({ freshMs: 60_000, maxEntries: 100 })
    await cache.load('pr', async () => 'closed')
    let finishEarly: (value: string) => void = () => {}
    cache.expire('pr')
    const early = cache.load('pr', () => new Promise((resolve) => (finishEarly = resolve)))
    expect(cache.read('pr')).toBe('closed')

    // The chat reopened the pull request while that read was out.
    cache.expire('pr')
    const after = cache.load('pr', async () => 'open')
    finishEarly('closed')
    await early
    expect(await after).toBe('open')
    expect(cache.read('pr')).toBe('open')

    cache.expire('pr')
    await cache.load('pr', async () => null)
    expect(cache.read('pr')).toBe('open')
  })

  it('keeps counting an answer against the budget while it is reread', async () => {
    const cache = createHoverPreviewCache<string>({
      freshMs: 60_000,
      maxEntries: 100,
      budget: { maxBytes: 10, sizeOf: (value) => value.length }
    })
    await cache.load('a', async () => 'aaaaaa')
    cache.expire('a')
    let failA: (value: null) => void = () => {}
    const reread = cache.load('a', () => new Promise((resolve) => (failA = resolve)))
    await cache.load('b', async () => 'bbbbbb')
    failA(null)
    await reread
    expect([cache.read('a'), cache.read('b')]).toEqual([null, 'bbbbbb'])
  })
})
