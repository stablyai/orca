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
    currentPackageDigest: 'current',
    lockSource: 'stablyai/orca',
    errorCategory: null,
    ...overrides
  }
}

describe('groupSkillFreshness', () => {
  it('marks an eligible outdated skill as update-available with one location', () => {
    const groups = groupSkillFreshness([placement('orca-cli')], ['orca-cli'])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      name: 'orca-cli',
      status: 'update-available',
      orcaOwned: true,
      lockSource: 'stablyai/orca'
    })
    expect(groups[0]?.locations).toEqual([
      {
        id: expect.any(String),
        path: '/home/.agents/skills/orca-cli',
        chip: null,
        participatesInGlobalFreshness: true
      }
    ])
  })

  it('sorts Orca-owned skills first, then by name', () => {
    const groups = groupSkillFreshness(
      [
        placement('computer-use', { lockSource: 'acme/agent-skills' }),
        placement('linear-tickets', { lockSource: null }),
        placement('orchestration'),
        placement('orca-cli', { lockSource: 'https://github.com/StablyAI/orca.git' })
      ],
      ['computer-use', 'linear-tickets', 'orca-cli', 'orchestration']
    )
    expect(groups.map((group) => [group.name, group.orcaOwned])).toEqual([
      ['orca-cli', true],
      ['orchestration', true],
      ['computer-use', false],
      ['linear-tickets', false]
    ])
    expect(groups.find((group) => group.name === 'computer-use')?.lockSource).toBe(
      'acme/agent-skills'
    )
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
    // Why: without a list of past releases a differing plugin copy cannot be told from
    // another vendor's skill, and Orca never writes there.
    const groups = groupSkillFreshness(
      [placement('dataviz', { status: 'outdated', topology: 'plugin-cache' })],
      []
    )
    expect(groups).toEqual([])
  })

  it('lists a skill whose only fault cannot be fixed by the update, so Details explains it', () => {
    const groups = groupSkillFreshness(
      [
        placement('dataviz', { topology: 'independent-copy' }),
        placement('linear-tickets', { status: 'inaccessible' })
      ],
      []
    )
    expect(groups).toEqual([
      {
        name: 'dataviz',
        status: 'cannot-update',
        orcaOwned: true,
        lockSource: 'stablyai/orca',
        locations: [
          {
            id: expect.any(String),
            path: '/home/.agents/skills/dataviz',
            chip: 'duplicate',
            participatesInGlobalFreshness: true
          }
        ]
      },
      {
        name: 'linear-tickets',
        status: 'cannot-update',
        orcaOwned: true,
        lockSource: 'stablyai/orca',
        locations: [
          {
            id: expect.any(String),
            path: '/home/.agents/skills/linear-tickets',
            chip: 'inaccessible',
            participatesInGlobalFreshness: true
          }
        ]
      }
    ])
  })

  it('groups a blocked skill and flags the culprit location, not the main copy', () => {
    const groups = groupSkillFreshness(
      [
        placement('orchestration'),
        placement('orchestration', {
          rootId: 'home-claude',
          unresolvedPath: '/home/.claude/skills/orchestration',
          topology: 'external-link'
        })
      ],
      []
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.status).toBe('cannot-update')
    // Why: the out-of-date main copy is bare; only the blocking copy carries a chip.
    expect(groups[0]?.locations).toEqual([
      {
        id: expect.any(String),
        path: '/home/.agents/skills/orchestration',
        chip: null,
        participatesInGlobalFreshness: true
      },
      {
        id: expect.any(String),
        path: '/home/.claude/skills/orchestration',
        chip: 'external-link',
        participatesInGlobalFreshness: true
      }
    ])
  })

  it('blocks a skill whose only outdated copy is an unreachable duplicate', () => {
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
      {
        id: expect.any(String),
        path: '/home/.agents/skills/orchestration',
        chip: 'current',
        participatesInGlobalFreshness: true
      },
      {
        id: expect.any(String),
        path: '/home/.factory/skills/orchestration',
        chip: 'duplicate',
        participatesInGlobalFreshness: true
      }
    ])
  })

  it('ranks a read failure over topology and maps every topology', () => {
    const chipFor = (overrides: Partial<SkillFreshnessInstallation>): string | null =>
      groupSkillFreshness(
        [placement('s', { status: 'outdated' }), placement('s', overrides)],
        ['s']
      )[0]?.locations.find((location) => location.path.includes('culprit'))?.chip ?? null
    const at = (path: string, rest: Partial<SkillFreshnessInstallation>) => ({
      unresolvedPath: `/culprit/${path}`,
      ...rest
    })
    expect(chipFor(at('b', { status: 'inaccessible', topology: 'read-only' }))).toBe('inaccessible')
    expect(chipFor(at('c', { topology: 'independent-copy' }))).toBe('duplicate')
    expect(chipFor(at('d', { topology: 'external-link' }))).toBe('external-link')
    expect(chipFor(at('e', { topology: 'broken-link' }))).toBe('broken-link')
    expect(chipFor(at('f', { topology: 'read-only' }))).toBe('read-only')
    expect(chipFor(at('g', { topology: 'repo-scope' }))).toBe('in-a-repo')
    expect(chipFor(at('h', { topology: 'plugin-cache' }))).toBe('plugin-cache')
    expect(chipFor(at('i', { status: 'current', topology: 'provider-alias' }))).toBe('current')
    expect(chipFor(at('k', { status: 'outdated', topology: 'provider-alias' }))).toBeNull()
    expect(chipFor(at('m', { status: 'inaccessible', topology: 'repo-scope' }))).toBe(
      'inaccessible'
    )
  })

  it('raises no group when every finding is project-owned', () => {
    expect(
      groupSkillFreshness(
        [placement('computer-use', { status: 'outdated', topology: 'repo-scope' })],
        []
      )
    ).toEqual([])
  })

  it('still lists a project copy inside a group another placement earned', () => {
    const groups = groupSkillFreshness(
      [
        placement('computer-use', { status: 'outdated', topology: 'read-only' }),
        placement('computer-use', {
          status: 'outdated',
          topology: 'repo-scope',
          unresolvedPath: '/home/projects/work/.agents/skills/computer-use'
        })
      ],
      []
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]?.locations.map((location) => location.chip)).toContain('in-a-repo')
  })

  it('marks project and plugin copies as ones the global update never judged', () => {
    const groups = groupSkillFreshness(
      [
        placement('computer-use', { status: 'outdated', topology: 'read-only' }),
        placement('computer-use', {
          status: 'outdated',
          topology: 'plugin-cache',
          unresolvedPath: '/home/.claude/plugins/cache/pack/skills/computer-use'
        }),
        placement('computer-use', {
          status: 'outdated',
          topology: 'repo-scope',
          unresolvedPath: '/home/projects/work/.agents/skills/computer-use'
        })
      ],
      []
    )

    expect(
      groups[0]?.locations.map((location) => [
        location.chip,
        location.participatesInGlobalFreshness
      ])
    ).toEqual([
      ['read-only', true],
      ['plugin-cache', false],
      ['in-a-repo', false]
    ])
  })
})
