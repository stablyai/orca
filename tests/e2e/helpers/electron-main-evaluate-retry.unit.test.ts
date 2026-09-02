import { describe, expect, it } from 'vitest'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

const transient = (): Error =>
  new Error('Execution context was destroyed, most likely because of a navigation.')

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

  it('rides out the startup window that made the paired-client launch flaky', async () => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        if (calls < 3) {
          throw transient()
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

  it('gives up rather than looping forever when the app never becomes evaluable', async () => {
    let calls = 0
    await expect(
      retryTransientMainEvaluate(async () => {
        calls += 1
        throw transient()
      })
    ).rejects.toThrow(/Execution context was destroyed/)
    expect(calls).toBe(5)
  })
})
