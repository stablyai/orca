import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  getMostUrgentPromptCacheStartedAt,
  getPromptCacheCountdownForPane
} from './prompt-cache-timer-selection'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

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

describe('getPromptCacheCountdownForPane', () => {
  it('selects the exact pane timer with the ttl used for gating', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)
    const otherPaneKey = makePaneKey('tab-1', LEAF_B)

    expect(
      getPromptCacheCountdownForPane(
        paneKey,
        {
          [paneKey]: 300,
          [otherPaneKey]: 100
        },
        5000
      )
    ).toEqual({ startedAt: 300, ttlMs: 5000 })
  })

  it('does not fall back to seed timers for per-pane row ownership', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane(paneKey, { 'tab-1:seed': 300 }, 5000)).toBeNull()
  })

  it('rejects malformed pane keys and null timer values', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane('tab-1:1', { 'tab-1:1': 300 }, 5000)).toBeNull()
    expect(getPromptCacheCountdownForPane(paneKey, { [paneKey]: null }, 5000)).toBeNull()
  })

  it('requires a positive ttl', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane(paneKey, { [paneKey]: 300 }, 0)).toBeNull()
  })
})
