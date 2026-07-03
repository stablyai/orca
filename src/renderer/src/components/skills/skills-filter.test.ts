import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import {
  SKILLS_FILTER_QUERY_MAX_BYTES,
  countSkillsBySource,
  filterSkills,
  isSkillsFilterQueryTooLarge
} from './skills-filter'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'id',
    name: 'Review',
    description: 'Code review',
    providers: ['codex'],
    sourceKind: 'home',
    sourceLabel: 'Codex home',
    rootPath: '/root',
    directoryPath: '/root/review',
    skillFilePath: '/root/review/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

describe('skills filtering', () => {
  it('filters by provider, source, and text query', () => {
    const skills = [
      skill({ name: 'React Patterns', providers: ['codex'], sourceKind: 'home' }),
      skill({
        id: 'repo',
        name: 'Docs Writer',
        description: 'Write docs',
        providers: ['claude'],
        sourceKind: 'repo'
      })
    ]

    expect(
      filterSkills(skills, { query: 'docs', provider: 'claude', sourceKind: 'repo' }).map(
        (item) => item.name
      )
    ).toEqual(['Docs Writer'])
    expect(filterSkills(skills, { query: 'docs', provider: 'codex', sourceKind: 'all' })).toEqual(
      []
    )
  })

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
        provider: 'all',
        sourceKind: 'all'
      })
    ).toEqual([])
  })

  it('counts skills by source kind', () => {
    expect(
      countSkillsBySource([
        skill({ sourceKind: 'home' }),
        skill({ id: 'repo', sourceKind: 'repo' }),
        skill({ id: 'plugin', sourceKind: 'plugin' })
      ])
    ).toEqual({ home: 1, repo: 1, bundled: 0, plugin: 1 })
  })
})
