import { describe, expect, it } from 'vitest'
import {
  isSkillDeletable,
  skillDeletionEligibility,
  SKILL_DELETE_BLOCK_MESSAGES
} from './skill-deletion-eligibility'
import type { SkillSourceKind } from './skills'

describe('skillDeletionEligibility', () => {
  it.each<[SkillSourceKind, boolean]>([
    ['home', true],
    ['repo', true],
    ['bundled', false],
    ['plugin', false]
  ])('decides %s', (sourceKind, deletable) => {
    expect(skillDeletionEligibility({ sourceKind }).deletable).toBe(deletable)
    expect(isSkillDeletable({ sourceKind })).toBe(deletable)
  })

  it('names the reason a bundled skill would come back', () => {
    const eligibility = skillDeletionEligibility({ sourceKind: 'bundled' })
    expect(eligibility).toEqual({
      deletable: false,
      reason: 'bundled',
      message: SKILL_DELETE_BLOCK_MESSAGES.bundled
    })
  })

  it('points a plugin skill at the plugin rather than the file', () => {
    const eligibility = skillDeletionEligibility({ sourceKind: 'plugin' })
    expect(eligibility).toMatchObject({ deletable: false, reason: 'plugin' })
  })

  it('has a message for every host-only reason the client never predicts', () => {
    // The client cannot know these; they arrive on the result, and the band
    // still has to say something specific for each.
    expect(SKILL_DELETE_BLOCK_MESSAGES.unowned).toContain('outside')
    expect(SKILL_DELETE_BLOCK_MESSAGES.missing).toBeTruthy()
    expect(SKILL_DELETE_BLOCK_MESSAGES.stale).toBeTruthy()
  })
})
