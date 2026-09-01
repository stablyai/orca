import { describe, expect, it } from 'vitest'
import { canSendConflictsToAgent } from './conflict-handoff-gate'

describe('canSendConflictsToAgent', () => {
  it('allows the hand-off while live conflicts exist', () => {
    expect(canSendConflictsToAgent(3, 'rebase')).toBe(true)
    expect(canSendConflictsToAgent(1, 'unknown')).toBe(true)
  })

  it('allows the hand-off for a stopped operation with nothing unmerged', () => {
    expect(canSendConflictsToAgent(0, 'rebase')).toBe(true)
    expect(canSendConflictsToAgent(0, 'merge')).toBe(true)
    expect(canSendConflictsToAgent(0, 'cherry-pick')).toBe(true)
  })

  it('blocks the hand-off on a clean tree with no operation', () => {
    expect(canSendConflictsToAgent(0, 'unknown')).toBe(false)
  })
})
