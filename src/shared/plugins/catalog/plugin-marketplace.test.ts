import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_MARKETPLACE_REPOSITORY,
  PLUGIN_MARKETPLACE_CATEGORY_LIMIT,
  PLUGIN_MARKETPLACE_ENTRY_LIMIT,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isSameGitRepository,
  pluginMarketplaceSchema
} from './plugin-marketplace'

function listing(id = 'community.nord'): Record<string, unknown> {
  return {
    id,
    source: { kind: 'git', url: 'https://github.com/community/nord.git', ref: 'v1.0.0' },
    description: 'A theme pack',
    categories: ['themes']
  }
}

describe('pluginMarketplaceSchema', () => {
  it.each([
    ['root', { name: 'Plugins', owner: 'team', plugins: [], extra: true }],
    ['entry', { name: 'Plugins', owner: 'team', plugins: [{ ...listing(), official: true }] }],
    [
      'source',
      {
        name: 'Plugins',
        owner: 'team',
        plugins: [
          {
            ...listing(),
            source: {
              kind: 'git',
              url: 'https://github.com/community/nord.git',
              ref: 'main',
              depth: 1
            }
          }
        ]
      }
    ]
  ])('rejects unknown keys at the %s boundary', (_boundary, marketplace) => {
    expect(pluginMarketplaceSchema.safeParse(marketplace).success).toBe(false)
  })

  it.each([
    ['an unqualified id', { ...listing(), id: 'nord' }],
    [
      'a missing ref',
      {
        ...listing(),
        source: { kind: 'git', url: 'https://github.com/community/nord.git', ref: '' }
      }
    ],
    [
      'an executable Git transport',
      {
        ...listing(),
        source: { kind: 'git', url: 'ext::sh -c exploit', ref: 'main' }
      }
    ],
    ['a duplicate category', { ...listing(), categories: ['themes', 'themes'] }],
    [
      'too many categories',
      {
        ...listing(),
        categories: Array.from(
          { length: PLUGIN_MARKETPLACE_CATEGORY_LIMIT + 1 },
          (_, index) => `category-${index}`
        )
      }
    ]
  ])('rejects %s', (_label, entry) => {
    expect(
      pluginMarketplaceSchema.safeParse({ name: 'Plugins', owner: 'team', plugins: [entry] })
        .success
    ).toBe(false)
  })

  it('rejects duplicate plugin identities', () => {
    const parsed = pluginMarketplaceSchema.safeParse({
      name: 'Plugins',
      owner: 'team',
      plugins: [listing(), listing()]
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'duplicate plugin id: community.nord' })
        ])
      )
    }
  })

  it('caps the marketplace entry count', () => {
    const plugins = Array.from({ length: PLUGIN_MARKETPLACE_ENTRY_LIMIT + 1 }, (_, index) =>
      listing(`publisher.plugin-${index}`)
    )
    expect(
      pluginMarketplaceSchema.safeParse({ name: 'Plugins', owner: 'team', plugins }).success
    ).toBe(false)
  })
})

describe('marketplace provenance contracts', () => {
  it('does not trust lookalike organizations or hosts', () => {
    expect(isOfficialOrganizationGitSource('https://github.com/stablyai-fakes/orca-skills')).toBe(
      false
    )
    expect(isOfficialOrganizationGitSource('https://gitlab.com/stablyai/orca-skills')).toBe(false)
    expect(isOfficialOrganizationGitSource('git@github.com:stablyai/../evil/orca-skills.git')).toBe(
      false
    )
  })

  it('rejects a listing whose Git host starts with a dash or contains ..', () => {
    for (const url of ['git@-oProxyCommand=evil:a/b.git', 'https://github..com/a/b.git']) {
      expect(
        pluginMarketplaceSchema.safeParse({
          name: 'Community plugins',
          owner: 'community',
          plugins: [{ ...listing(), source: { kind: 'git', url, ref: 'main' } }]
        }).success
      ).toBe(false)
    }
  })

  it('recognizes only the canonical official marketplace repository', () => {
    expect(
      isOfficialMarketplaceGitSource(
        `git@github.com:stablyai/${OFFICIAL_MARKETPLACE_REPOSITORY}.git`
      )
    ).toBe(true)
    expect(isOfficialMarketplaceGitSource('git@github.com:stablyai/plugins.git')).toBe(false)
  })
})

describe('isSameGitRepository', () => {
  it('matches respellings and treats a GitLab subgroup move as a different repository', () => {
    expect(
      isSameGitRepository(
        'https://gitlab.com/acme/team-a/tool.git',
        'git@gitlab.com:Acme/Team-A/Tool'
      )
    ).toBe(true)
    // A self-hosted server may serve these as two repositories, so an approval must not carry.
    expect(
      isSameGitRepository(
        'https://git.example.com/team/Plugin.git',
        'https://git.example.com/team/plugin.git'
      )
    ).toBe(false)
    expect(
      isSameGitRepository(
        'https://gitlab.com/acme/team-a/tool',
        'https://gitlab.com/acme/evil/tool'
      )
    ).toBe(false)
  })
})
