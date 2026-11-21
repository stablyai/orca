import { afterEach, describe, expect, it, vi } from 'vitest'
import { outfitFiles } from './bot-outfit-art'

afterEach(() => {
  vi.useRealTimers()
})

describe('an outfit file read', () => {
  it('tries again while a picture still waits, so a failed read shows the outfit without a remount', async () => {
    vi.useFakeTimers()
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('art')
    const file = outfitFiles({ 'tie.json': read }, (outfit) => `${outfit}.json`)('tie')
    const arrived = vi.fn()
    file?.subscribe(arrived)
    await vi.advanceTimersByTimeAsync(0)
    expect(file?.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5000)
    expect(file?.value).toBe('art')
    expect(arrived).toHaveBeenCalledOnce()
  })
})
