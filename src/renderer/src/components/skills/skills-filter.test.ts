import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { countSkillsBySource, filterSkills } from './skills-filter'

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
