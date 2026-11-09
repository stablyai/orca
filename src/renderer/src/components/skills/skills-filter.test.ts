import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import {
  SKILLS_FILTER_QUERY_MAX_BYTES,
  filterSkills,
  isSkillsFilterQueryTooLarge
} from './skills-filter'

describe('skills filtering', () => {
  it('rejects oversized pasted queries before reading skill metadata', () => {
    const oversizedQuery = 'secret-skill-filter'.repeat(SKILLS_FILTER_QUERY_MAX_BYTES)
    const throwingSkills = [
      {
        get sourceKind(): DiscoveredSkill['sourceKind'] {
          throw new Error('oversized skill filters must not scan source kinds')
        },
        get providers(): DiscoveredSkill['providers'] {
          throw new Error('oversized skill filters must not scan providers')
        },
        get name(): string {
          throw new Error('oversized skill filters must not scan names')
        }
      }
    ] as DiscoveredSkill[]

    expect(isSkillsFilterQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      filterSkills(throwingSkills, {
        query: oversizedQuery,
        agent: 'all',
        sourceKind: 'all'
      })
    ).toEqual([])
  })
})
