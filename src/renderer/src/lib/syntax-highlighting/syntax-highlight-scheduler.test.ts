import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleSyntaxHighlighting } from './syntax-highlight-scheduler'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scheduleSyntaxHighlighting', () => {
  it('shares one slice between blocks and takes turns', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const runs: string[] = []
    const budgets: number[] = []
    const job = (name: string, steps: number) => {
      let left = steps
      return (budgetMs: number) => {
        runs.push(name)
        budgets.push(budgetMs)
        // Each step spends the whole slice.
        now += budgetMs
        left -= 1
        return left === 0
      }
    }

    scheduleSyntaxHighlighting(job('a', 2))
    scheduleSyntaxHighlighting(job('b', 2))
    await vi.waitFor(() => expect(runs).toHaveLength(4))

    expect(runs).toEqual(['a', 'b', 'a', 'b'])
    // One block per slice: the first spends it all, so the other waits for the next.
    expect(budgets).toEqual([6, 6, 6, 6])
  })

  it('stops a cancelled block', async () => {
    const steps: string[] = []
    const cancel = scheduleSyntaxHighlighting(() => {
      steps.push('cancelled')
      return false
    })
    cancel()
    scheduleSyntaxHighlighting(() => {
      steps.push('kept')
      return true
    })

    await vi.waitFor(() => expect(steps).toEqual(['kept']))
  })
})
