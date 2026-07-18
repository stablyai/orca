import { describe, expect, it } from 'vitest'
import type { SkillFreshnessInstallation } from '../../../../shared/skill-freshness'
import { groupSkillFreshness } from './skill-freshness-grouping'

function placement(
  name: string,
  overrides: Partial<SkillFreshnessInstallation> = {}
): SkillFreshnessInstallation {
  return {
    id: `${name}-${overrides.rootId ?? 'home-agents'}-${overrides.unresolvedPath ?? 'a'}`,
    name,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${name}`,
    resolvedPath: `/home/.agents/skills/${name}`,
    physicalIdentity: `physical-${name}`,
    topology: 'canonical-copy',
    status: 'outdated',
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: 'old',
    errorCategory: null,
    ...overrides
  }
}

describe('groupSkillFreshness', () => {
  it('marks an eligible outdated skill as update-available with one location', () => {
    const groups = groupSkillFreshness([placement('orca-cli')], ['orca-cli'])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ name: 'orca-cli', status: 'update-available' })
    expect(groups[0]?.locations).toEqual([
      { id: expect.any(String), path: '/home/.agents/skills/orca-cli', chip: null }
    ])
  })

  it('hides skills with nothing out of date (current, unrecognized-only, unreadable-only)', () => {
    const groups = groupSkillFreshness(
      [
        placement('orca-cli', { status: 'current' }),
        placement('dataviz', { status: 'unrecognized', topology: 'independent-copy' }),
        placement('linear-tickets', { status: 'inaccessible' })
      ],
      []
    )
    expect(groups).toEqual([])
  })

  it('groups a blocked skill and flags the culprit location, not the main copy', () => {
    const groups = groupSkillFreshness(
      [
        placement('orchestration'),
        placement('orchestration', {
          rootId: 'home-claude',
          unresolvedPath: '/home/.claude/skills/orchestration',
          status: 'unrecognized',
          topology: 'independent-copy'
        })
      ],
      []
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.status).toBe('cannot-update')
    // Why: the out-of-date main copy is bare; only the poisoning copy carries a chip.
    expect(groups[0]?.locations).toEqual([
      { id: expect.any(String), path: '/home/.agents/skills/orchestration', chip: null },
      { id: expect.any(String), path: '/home/.claude/skills/orchestration', chip: 'unrecognized' }
    ])
  })

  it('prefers a location status over its topology and maps every topology to a chip', () => {
    const chipFor = (overrides: Partial<SkillFreshnessInstallation>): string | null =>
      groupSkillFreshness(
        [placement('s', { status: 'outdated' }), placement('s', overrides)],
        ['s']
      )[0]?.locations.find((location) => location.path.includes('culprit'))?.chip ?? null
    const at = (path: string, rest: Partial<SkillFreshnessInstallation>) => ({
      unresolvedPath: `/culprit/${path}`,
      ...rest
    })
    expect(chipFor(at('a', { status: 'unrecognized', topology: 'independent-copy' }))).toBe(
      'unrecognized'
    )
    expect(chipFor(at('b', { status: 'inaccessible', topology: 'read-only' }))).toBe('inaccessible')
    expect(chipFor(at('c', { topology: 'independent-copy' }))).toBe('duplicate')
    expect(chipFor(at('d', { topology: 'external-link' }))).toBe('external-link')
    expect(chipFor(at('e', { topology: 'broken-link' }))).toBe('broken-link')
    expect(chipFor(at('f', { topology: 'read-only' }))).toBe('read-only')
    expect(chipFor(at('g', { topology: 'repo-scope' }))).toBe('in-a-repo')
    expect(chipFor(at('h', { topology: 'plugin-cache' }))).toBe('plugin-cache')
    expect(chipFor(at('i', { status: 'current', topology: 'provider-alias' }))).toBe('current')
  })
})
