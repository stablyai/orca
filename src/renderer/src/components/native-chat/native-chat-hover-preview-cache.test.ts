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
})
