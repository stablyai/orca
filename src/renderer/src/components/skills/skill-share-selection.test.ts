import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { addShareableSkillResults, eligibleShareSkillCount } from './skill-share-selection'

function skill(name: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: `${overrides.sourceKind ?? 'home'}:${name}`,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/home/dev/.agents/skills',
    directoryPath: `/home/dev/.agents/skills/${name}`,
    skillFilePath: `/home/dev/.agents/skills/${name}/SKILL.md`,
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

describe('eligibleShareSkillCount', () => {
  // Why: the count labels the "Select all" button, so it has to predict what
  // that click actually produces — duplicates collapse, ineligible rows drop.
  it('matches what selecting all results would hold', () => {
    const results = [
      skill('alpha'),
      skill('alpha', { sourceKind: 'repo' }),
      skill('beta', { sourceKind: 'plugin' }),
      skill('gamma', { installed: false })
    ]
    expect(eligibleShareSkillCount(results, true)).toBe(1)
    expect(addShareableSkillResults(new Set(), results, results, true).size).toBe(1)
  })

  it('counts nothing when the skills live on another machine', () => {
    expect(eligibleShareSkillCount([skill('alpha'), skill('beta')], false)).toBe(0)
  })
})
