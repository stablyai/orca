import { describe, expect, it } from 'vitest'
import { ranksFollowPersistedOrder, smartSortPhase } from './smart-sort-phase'

describe('smartSortPhase', () => {
  it('is cold until latched, then live, and absent outside Smart', () => {
    expect(smartSortPhase('smart', false)).toBe('cold')
    expect(smartSortPhase('smart', true)).toBe('live')
    expect(smartSortPhase('recent', true)).toBeNull()
  })

  it('follows persisted ranks under Manual and cold Smart only', () => {
    expect(ranksFollowPersistedOrder('manual', true)).toBe(true)
    expect(ranksFollowPersistedOrder('smart', false)).toBe(true)
    expect(ranksFollowPersistedOrder('smart', true)).toBe(false)
    expect(ranksFollowPersistedOrder('recent', false)).toBe(false)
  })
})
