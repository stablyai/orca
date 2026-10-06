import { describe, expect, it } from 'vitest'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

const transientMessages = [
  'Execution context was destroyed, most likely because of a navigation.',
  'electronApplication.evaluate: Resulting promise was garbage collected.'
]

describe('retryTransientMainEvaluate', () => {
  it('returns the first successful read without retrying', async () => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        return '/isolated/home'
      })
    ).resolves.toBe('/isolated/home')
    expect(calls).toBe(1)
  })

  it.each(transientMessages)('retries a transient startup failure: %s', async (message) => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        if (calls < 3) {
          throw new Error(message)
        }
        return '/isolated/home'
      })
    ).resolves.toBe('/isolated/home')
    expect(calls).toBe(3)
  })

  it('rethrows a real failure immediately instead of masking it behind retries', async () => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        throw new Error('Electron E2E HOME escaped the disposable profile boundary')
      })
    ).rejects.toThrow(/escaped the disposable profile/)
    expect(calls).toBe(1)
  })

  it.each(transientMessages)(
    'bounds retries when evaluation keeps failing: %s',
    async (message) => {
      let calls = 0
      await expect(
        retryTransientMainEvaluate(async () => {
          calls += 1
          throw new Error(message)
        })
      ).rejects.toThrow(message)
      expect(calls).toBe(5)
    }
  )

  it('does not retry a closed application', async () => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        throw new Error(
          'electronApplication.evaluate: Target page, context or browser has been closed'
        )
      })
    ).rejects.toThrow(/has been closed/)
    expect(calls).toBe(1)
  })
})
