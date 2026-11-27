import { afterEach, describe, expect, it, vi } from 'vitest'
import { outfitFiles } from './bot-outfit-art'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('an outfit file read', () => {
  it('fetches a failed read again within a moment, so the outfit shows without a remount', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{"A1":"art"}'))
    vi.stubGlobal('fetch', fetch)
    const file = outfitFiles<Record<string, string>>(
      { 'tie.json': '/assets/tie.json' },
      (outfit) => `${outfit}.json`
    )('tie')
    const arrived = vi.fn()
    file?.subscribe(arrived)
    await vi.advanceTimersByTimeAsync(0)
    expect(file?.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(500)
    expect(fetch.mock.calls).toEqual([['/assets/tie.json'], ['/assets/tie.json']])
    expect(file?.value).toEqual({ A1: 'art' })
    expect(arrived).toHaveBeenCalledOnce()
  })
})
