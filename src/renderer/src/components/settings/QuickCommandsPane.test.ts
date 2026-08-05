import { describe, expect, it, vi } from 'vitest'
import { shouldOpenQuickCommandAddIntent, warmProjectQuickCommandCaches } from './QuickCommandsPane'

describe('QuickCommandsPane add-command intent', () => {
  it('opens the add flow once for each new intent signal', () => {
    expect(shouldOpenQuickCommandAddIntent(undefined, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(0, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(1, 0)).toBe(true)
    expect(shouldOpenQuickCommandAddIntent(1, 1)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(2, 1)).toBe(true)
  })
})

describe('warmProjectQuickCommandCaches', () => {
  it('deduplicates repo ids and limits concurrent hooks reads', async () => {
    let active = 0
    let maxActive = 0
    const started: string[] = []
    const releases: (() => void)[] = []
    const warm = warmProjectQuickCommandCaches(
      ['repo-1', 'repo-2', 'repo-3', 'repo-4', 'repo-5', 'repo-6', 'repo-1'],
      (repoId) =>
        new Promise<void>((resolve) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          started.push(repoId)
          releases.push(() => {
            active -= 1
            resolve()
          })
        })
    )

    await vi.waitFor(() => expect(started).toHaveLength(4))
    expect(maxActive).toBe(4)
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(started).toHaveLength(6))
    releases.splice(0).forEach((release) => release())
    await warm

    expect(new Set(started).size).toBe(6)
    expect(maxActive).toBe(4)
  })
})
