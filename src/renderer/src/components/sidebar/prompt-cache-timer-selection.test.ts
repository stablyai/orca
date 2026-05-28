import { describe, expect, it } from 'vitest'
import { getMostUrgentPromptCacheStartedAt } from './prompt-cache-timer-selection'

describe('getMostUrgentPromptCacheStartedAt', () => {
  it('selects the oldest non-null timer for the worktree tabs in one cache pass', () => {
    const startedAt = getMostUrgentPromptCacheStartedAt([{ id: 'tab-1' }, { id: 'tab-2' }], {
      'tab-1:pane-a': 300,
      'tab-1:pane-b': null,
      'tab-2:seed': 200,
      'tab-3:pane-a': 100
    })

    expect(startedAt).toBe(200)
  })

  it('does not match tab id prefixes or malformed keys', () => {
    const startedAt = getMostUrgentPromptCacheStartedAt([{ id: 'tab-1' }], {
      'tab-10:pane-a': 100,
      'tab-1': 50,
      'tab-1:pane-a': 300
    })

    expect(startedAt).toBe(300)
  })
})
