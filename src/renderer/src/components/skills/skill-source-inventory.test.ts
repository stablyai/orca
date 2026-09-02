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
