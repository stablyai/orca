import { describe, expect, it, vi } from 'vitest'
import { startWatcherGenerationReplacement } from './watcher-generation-replacement'

describe('startWatcherGenerationReplacement', () => {
  it('captures a synchronous claim-hook failure in the tracked replacement promise', async () => {
    const owner = { closed: false, generation: 4 }
    const failure = new Error('claim hook failed')
    const install = vi.fn<() => Promise<void>>()

    const replacement = startWatcherGenerationReplacement(
      owner,
      4,
      () => {
        throw failure
      },
      install
    )
    if (!replacement) {
      throw new Error('expected recovery generation to be claimed')
    }

    await expect(replacement.promise).rejects.toBe(failure)
    expect(owner.generation).toBe(5)
    expect(install).not.toHaveBeenCalled()
  })
})
