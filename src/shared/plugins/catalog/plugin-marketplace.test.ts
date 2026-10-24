import { describe, expect, it } from 'vitest'
import {
  OFFICIAL_MARKETPLACE_REPOSITORY,
  PLUGIN_MARKETPLACE_CATEGORY_LIMIT,
  PLUGIN_MARKETPLACE_ENTRY_LIMIT,
  isMarketplaceListingSupported,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  isReservedPluginIdentity,
  isSameGitRepository,
  parseGitRepositoryIdentity,
  pluginMarketplaceSchema,
  pluginMarketplaceTrustMetadataSchema
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
  it('parses a bounded, pinned Git marketplace index', () => {
    expect(
      pluginMarketplaceSchema.parse({
        name: 'Community plugins',
        owner: 'community',
        plugins: [listing()]
      })
    ).toEqual({
      name: 'Community plugins',
      owner: 'community',
      plugins: [listing()]
    })
  })

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
  it.each([
    ['stablyai.orca-skills', true, true],
    ['stablyai.skills', true, false],
    ['community.orca-skills', true, false],
    ['community.skills', false, false],
    ['orca.skills', true, false],
    ['orca-labs.skills', true, false],
    ['openai.skills', true, false],
    ['github.skills', true, false],
    ['orcas.skills', false, false],
    ['invalid', false, false]
  ])('classifies %s', (pluginKey, reserved, official) => {
    expect(isReservedPluginIdentity(pluginKey)).toBe(reserved)
    expect(isOfficialPluginIdentity(pluginKey)).toBe(official)
  })

  it.each([
    'https://github.com/stablyai/orca-skills.git',
    'ssh://git@github.com/stablyai/orca-skills.git',
    'git@github.com:stablyai/orca-skills.git'
  ])('accepts official organization source %s', (source) => {
    expect(isOfficialOrganizationGitSource(source)).toBe(true)
  })

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

  it('parses nested repository paths without confusing the repository name', () => {
    expect(parseGitRepositoryIdentity('https://gitlab.com/team/subgroup/plugin.git')).toEqual({
      host: 'gitlab.com',
      owner: 'team',
      repository: 'plugin',
      path: 'team/subgroup/plugin'
    })
  })

  it('prevents an untrusted listing from self-awarding trust metadata', () => {
    expect(pluginMarketplaceTrustMetadataSchema.parse({ official: true, bundled: true })).toEqual({
      official: true,
      bundled: true
    })
    expect(
      pluginMarketplaceTrustMetadataSchema.safeParse({ official: false, bundled: true }).success
    ).toBe(false)
  })

  it('marks listings with a deferred contribution category as unsupported', () => {
    expect(isMarketplaceListingSupported(['vm-recipes', 'official'])).toBe(true)
    expect(isMarketplaceListingSupported(['keybindings'])).toBe(true)
    expect(isMarketplaceListingSupported([])).toBe(true)
    expect(isMarketplaceListingSupported(['skills', 'official'])).toBe(false)
    for (const supported of ['themes', 'terminal-themes', 'icons', 'icon-themes']) {
      expect(isMarketplaceListingSupported([supported, 'official'])).toBe(true)
    }
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
    expect(
      isSameGitRepository(
        'https://gitlab.com/acme/team-a/tool',
        'https://gitlab.com/acme/evil/tool'
      )
    ).toBe(false)
  })
})
