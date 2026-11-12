import { describe, expect, it } from 'vitest'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

describe('createHoverPreviewCache', () => {
  it('does not publish a response whose owner rejects it at cache commit', async () => {
    const cache = createHoverPreviewCache<string>({ freshMs: 60_000, maxEntries: 100 })
    const response = Promise.withResolvers<string>()
    let current = true
    const pending = cache.load(
      'alice',
      () => response.promise,
      () => current
    )
    response.resolve('bob response')
    current = false
    await expect(pending).resolves.toBeNull()
    expect(cache.read('alice')).toBeNull()
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
})
