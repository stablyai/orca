import { describe, expect, it } from 'vitest'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

describe('createHoverPreviewCache', () => {
  it('forgets every answer on clear', async () => {
    const cache = createHoverPreviewCache<string>({ freshMs: 60_000, maxEntries: 100 })
    await cache.load('ENG-1', async () => 'first account')
    cache.clear()
    expect(cache.read('ENG-1')).toBeNull()
    expect(await cache.load('ENG-1', async () => 'second account')).toBe('second account')
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
