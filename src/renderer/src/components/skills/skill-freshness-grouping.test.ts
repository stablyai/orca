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

  it('hides skills whose every copy is current', () => {
    const groups = groupSkillFreshness(
      [
        placement('orca-cli', { status: 'current' }),
        placement('orca-cli', { status: 'current', topology: 'provider-alias' })
      ],
      []
    )
    expect(groups).toEqual([])
  })

  it('keeps a plugin-managed copy of a same-named skill out of the list', () => {
    // Why: the vendor owns that copy, so it is not drift the user can act on —
    // reporting it put permanent amber on any ordinary plugin install.
    const groups = groupSkillFreshness(
      [placement('dataviz', { status: 'unrecognized', topology: 'plugin-cache' })],
      []
    )
    expect(groups).toEqual([])
  })

  it('lists a skill whose only fault cannot be fixed by the update, so Details explains it', () => {
    // Why: these turn the setup-rail badge amber and its Details opens this list. Omitting
    // them left that list headlined "all up to date" over nothing, contradicting the badge.
    const groups = groupSkillFreshness(
      [
        placement('dataviz', { status: 'unrecognized', topology: 'independent-copy' }),
        placement('linear-tickets', { status: 'inaccessible' })
      ],
      []
    )
    expect(groups).toEqual([
      {
        name: 'dataviz',
        status: 'cannot-update',
        locations: [
          { id: expect.any(String), path: '/home/.agents/skills/dataviz', chip: 'unrecognized' }
        ]
      },
      {
        name: 'linear-tickets',
        status: 'cannot-update',
        locations: [
          {
            id: expect.any(String),
            path: '/home/.agents/skills/linear-tickets',
            chip: 'inaccessible'
          }
        ]
      }
    ])
  })

  it('lists an edited canonical copy, which is what an update would overwrite', () => {
    const groups = groupSkillFreshness([placement('orchestration', { status: 'unrecognized' })], [])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.status).toBe('cannot-update')
    expect(groups[0]?.locations[0]?.chip).toBe('unrecognized')
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

  it('blocks a skill whose only outdated copy is an unreachable duplicate', () => {
    // Why: the global command reports "already up to date" here, so the group must
    // read as skipped with the duplicate flagged rather than promising an update.
    const groups = groupSkillFreshness(
      [
        placement('orchestration', { status: 'current' }),
        placement('orchestration', {
          rootId: 'home-factory',
          unresolvedPath: '/home/.factory/skills/orchestration',
          topology: 'independent-copy'
        })
      ],
      []
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.status).toBe('cannot-update')
    expect(groups[0]?.locations).toEqual([
      { id: expect.any(String), path: '/home/.agents/skills/orchestration', chip: 'current' },
      { id: expect.any(String), path: '/home/.factory/skills/orchestration', chip: 'duplicate' }
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
    // Why: a bare chip is what the reason copy reads as "behind, and a reinstall fixes
    // it". A copy that is ahead must be told apart, or that advice rolls it back.
    expect(chipFor(at('k', { status: 'newer-known', topology: 'canonical-copy' }))).toBe('newer')
    expect(chipFor(at('j', { status: 'unrecognized', topology: 'plugin-cache' }))).toBe(
      'plugin-cache'
    )
  })
})
