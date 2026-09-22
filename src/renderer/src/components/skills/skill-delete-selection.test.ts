import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import {
  addDeletableSkillResults,
  eligibleDeleteSkillCount,
  isSkillDeleteEligible,
  retainedDeletableSkillSelection,
  skillDeleteEligibilityReason
} from './skill-delete-selection'

function skill(overrides: Partial<DiscoveredSkill> & { id: string }): DiscoveredSkill {
  return {
    name: 'demo',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/root',
    directoryPath: '/root/demo',
    skillFilePath: '/root/demo/SKILL.md',
    installed: true,
    updatedAt: 1,
    ...overrides
  }
}

describe('delete selection', () => {
  it('keeps two rows sharing a name independently selectable', () => {
    // Share collapses duplicate names because two skills cannot publish under
    // one name. Delete has no such constraint — these are two distinct files.
    const skills = [
      skill({ id: 'a', rootPath: '/home/.agents/skills' }),
      skill({ id: 'b', rootPath: '/repo/.claude/skills' })
    ]
    expect(eligibleDeleteSkillCount(skills)).toBe(2)
    expect([...addDeletableSkillResults(new Set(), skills, skills)]).toEqual(['a', 'b'])
  })

  it('excludes bundled and plugin rows from select-all', () => {
    const skills = [
      skill({ id: 'a' }),
      skill({ id: 'b', sourceKind: 'bundled' }),
      skill({ id: 'c', sourceKind: 'plugin' }),
      skill({ id: 'd', sourceKind: 'repo' })
    ]
    expect(eligibleDeleteSkillCount(skills)).toBe(2)
    expect([...addDeletableSkillResults(new Set(), skills, skills)]).toEqual(['a', 'd'])
  })

  it('drops a selection whose row no longer exists after a rescan', () => {
    const current = new Set(['a', 'gone'])
    const retained = retainedDeletableSkillSelection(current, [skill({ id: 'a' })])
    expect([...retained]).toEqual(['a'])
  })

  it('returns the same set reference when a rescan changes nothing', () => {
    const skills = [skill({ id: 'a' }), skill({ id: 'b' })]
    const current = new Set(['a', 'b'])
    expect(retainedDeletableSkillSelection(current, skills)).toBe(current)
  })

  it('drops a row that became ineligible between scans', () => {
    const current = new Set(['a'])
    const retained = retainedDeletableSkillSelection(current, [
      skill({ id: 'a', sourceKind: 'plugin' })
    ])
    expect([...retained]).toEqual([])
  })

  it('gives a reason only when the row is not deletable', () => {
    expect(isSkillDeleteEligible(skill({ id: 'a' }))).toBe(true)
    expect(skillDeleteEligibilityReason(skill({ id: 'a' }))).toBeNull()
    expect(skillDeleteEligibilityReason(skill({ id: 'b', sourceKind: 'bundled' }))).toContain(
      'Bundled'
    )
    expect(skillDeleteEligibilityReason(skill({ id: 'c', sourceKind: 'plugin' }))).toContain(
      'plugin'
    )
  })
})
