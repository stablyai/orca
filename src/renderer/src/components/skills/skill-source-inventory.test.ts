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

  it('does not inspect skills without sources', () => {
    const unused = {
      ...skill(),
      get rootPath(): string {
        throw new Error('No source needs a count')
      }
    }
    expect(summarizeSkillSources(null)).toEqual([])
    expect(summarizeSkillSources(result({ skills: [unused] }))).toEqual([])
  })

  it('accepts frozen ownership lists and inputs without changing them', () => {
    const home = Object.freeze(source())
    const item = skill({ rootPaths: [home.path, '/co-owner', home.path] })
    Object.freeze(item.rootPaths)
    Object.freeze(item)
    const discovery = result({ sources: [home, source({ path: '/co-owner' })], skills: [item] })
    Object.freeze(discovery.sources)
    Object.freeze(discovery.skills)
    Object.freeze(discovery)
    expect(summarizeSkillSources(discovery).map((entry) => entry.skillCount)).toEqual([1, 1])
    expect(item.rootPaths).toEqual([home.path, '/co-owner', home.path])
  })

  it('counts a symlinked skill under every root that reached it', () => {
    const shared = source({ id: 'repo', path: '/repo/.agents/skills', sourceKind: 'repo' })
    const entries = summarizeSkillSources(
      result({
        sources: [source(), shared],
        skills: [skill({ rootPaths: ['/home/dev/.agents/skills', '/repo/.agents/skills'] })]
      })
    )
    expect(entries.map((entry) => entry.skillCount)).toEqual([1, 1])
  })

  it('reports why a root produced nothing instead of showing an empty count', () => {
    const entries = summarizeSkillSources(
      result({
        sources: [
          source({ id: 'missing', exists: false, skippedReason: 'missing' }),
          source({ id: 'remote', exists: false, skippedReason: 'remote-repo' }),
          source({ id: 'unknown', exists: false })
        ]
      })
    )
    expect(entries.map((entry) => entry.status)).toEqual(['missing', 'remote-repo', 'unavailable'])
    expect(scannedSkillSourceCount(entries)).toBe(0)
  })

  it('reports an unanswered root as unavailable even though it claims to exist', () => {
    // Why: the host cannot prove a stalled root is gone, so it reports exists:true
    // and carries the uncertainty in skippedReason. Reading exists first counted a
    // root nobody walked as scanned, and its retained skills as its full contents.
    const entries = summarizeSkillSources(
      result({
        sources: [source({ id: 'stalled', exists: true, skippedReason: 'unavailable' })],
        skills: [skill()]
      })
    )
    expect(entries.map((entry) => entry.status)).toEqual(['unavailable'])
    expect(scannedSkillSourceCount(entries)).toBe(0)
  })

  it('counts only roots that were actually scanned', () => {
    const entries = summarizeSkillSources(
      result({ sources: [source(), source({ id: 'gone', exists: false })] })
    )
    expect(scannedSkillSourceCount(entries)).toBe(1)
  })
})
