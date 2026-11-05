import { describe, expect, it } from 'vitest'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource
} from '../../../../shared/skills'
import { scannedSkillSourceCount, summarizeSkillSources } from './skill-source-inventory'

function source(overrides: Partial<SkillDiscoverySource> = {}): SkillDiscoverySource {
  return {
    id: 'home',
    label: 'Agent skills home',
    path: '/home/dev/.agents/skills',
    sourceKind: 'home',
    providers: ['agent-skills'],
    owner: null,
    exists: true,
    ...overrides
  }
}

function skill(overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    id: 'skill',
    name: 'skill',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/home/dev/.agents/skills',
    directoryPath: '/home/dev/.agents/skills/skill',
    skillFilePath: '/home/dev/.agents/skills/skill/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

function result(overrides: Partial<SkillDiscoveryResult> = {}): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt: 1, ...overrides }
}

describe('summarizeSkillSources', () => {
  it('counts each skill once per root, including a primary root omitted from rootPaths', () => {
    const shared = skill({ rootPaths: ['/other', '/other', '/unknown'] })
    const home = source()
    const other = source({ path: '/other' })
    const entries = summarizeSkillSources(
      result({
        sources: [home, other, other, source({ path: '/OTHER' })],
        skills: [shared, shared, skill({ rootPaths: [home.path, home.path] })]
      })
    )
    expect(entries.map((entry) => entry.skillCount)).toEqual([3, 2, 2, 0])
    expect(entries[0].source).toBe(home)
    expect(entries[1].source).toBe(other)
    expect(entries[2].source).toBe(other)
  })

  it('does not scan every skill again for each source', () => {
    let rootReads = 0
    const skills = Array.from({ length: 1000 }, () => ({
      ...skill(),
      get rootPath() {
        rootReads++
        return '/home/dev/.agents/skills'
      }
    }))
    const sources = Array.from({ length: 87 }, (_, index) => source({ id: `${index}` }))
    const entries = summarizeSkillSources(result({ skills, sources }))
    expect(entries.every((entry) => entry.skillCount === 1000)).toBe(true)
    expect(rootReads).toBeLessThanOrEqual(skills.length)
  })

  it('reports an unanswered root as unavailable even though it claims to exist', () => {
    // An unavailable root retains exists:true because absence is unproven; retained skills do not establish a full scan.
    const entries = summarizeSkillSources(
      result({
        sources: [source({ id: 'stalled', exists: true, skippedReason: 'unavailable' })],
        skills: [skill()]
      })
    )
    expect(entries.map((entry) => entry.status)).toEqual(['unavailable'])
    expect(scannedSkillSourceCount(entries)).toBe(0)
  })
})
