import { describe, expect, it } from 'vitest'
import { legacyPluginCatalog } from '../../../config/scripts/export-legacy-plugin-catalog.mjs'
import {
  PLUGIN_CATALOG_RELEASE_LIMIT,
  pluginCatalogSchema,
  pluginCatalogVersionError,
  selectPluginCatalogRelease
} from './plugin-catalog'
import { pluginCatalogReleaseSchema } from './plugin-catalog-release'
import { PLUGIN_MARKETPLACE_ENTRY_LIMIT, pluginMarketplaceSchema } from './plugin-marketplace'

function release(version: string, minimumOrca = '1.4.0') {
  return pluginCatalogReleaseSchema.parse({
    version,
    commit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    execution: 'data',
    minimumOrca,
    types: ['app-theme']
  })
}

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: { kind: 'git', url: `https://github.com/acme/${id}.git`, ref: 'main' },
    categories: ['themes'],
    releases: [release('1.0.0')],
    ...overrides
  }
}

function catalog(plugins: unknown[], extra: Record<string, unknown> = {}) {
  return { catalogVersion: 2, name: 'Acme', owner: 'acme', plugins, ...extra }
}

describe('plugin catalog', () => {
  it('keeps what it can read and skips the rest', () => {
    const parsed = pluginCatalogSchema.parse(
      catalog(
        [
          entry('acme.one', { surprise: true, description: 'x'.repeat(5_000) }),
          entry('acme.one', { categories: ['other'] }),
          entry('acme.two', { releases: [{ ...release('2.0.0'), types: ['widget'] }] }),
          entry('acme.three', {
            categories: [
              'themes',
              'themes',
              'Not A Slug',
              ...Array.from({ length: 30 }, (_, i) => `c${i}`)
            ],
            releases: [{ broken: true }, release('1.1.0')]
          }),
          { id: 5 }
        ],
        { future: { anything: true } }
      )
    )
    expect(parsed.plugins.map((plugin) => plugin.id)).toEqual(['acme.one', 'acme.three'])
    expect(parsed.plugins[0]).not.toHaveProperty('surprise')
    expect(parsed.plugins[0]?.description).toBeUndefined()
    expect(parsed.plugins[0]?.categories).toEqual(['themes'])
    expect(parsed.plugins[1]?.categories).toHaveLength(16)
    expect(parsed.plugins[1]?.categories.slice(0, 2)).toEqual(['themes', 'c0'])
    expect(parsed.plugins[1]?.releases.map((r) => r.version)).toEqual(['1.1.0'])
  })

  it('trims an oversized catalog and release list instead of refusing it', () => {
    const many = Array.from({ length: PLUGIN_MARKETPLACE_ENTRY_LIMIT + 5 }, (_, index) =>
      entry(`acme.p${index}`, {
        releases: Array.from({ length: PLUGIN_CATALOG_RELEASE_LIMIT + 3 }, (_, r) =>
          release(`1.0.${r}`)
        )
      })
    )
    const parsed = pluginCatalogSchema.parse(catalog(many))
    expect(parsed.plugins).toHaveLength(PLUGIN_MARKETPLACE_ENTRY_LIMIT)
    expect(parsed.plugins[0]?.releases).toHaveLength(PLUGIN_CATALOG_RELEASE_LIMIT)
  })

  it('refuses a newer catalog format with the fix, and requires the version', () => {
    expect(pluginCatalogVersionError(catalog([], { catalogVersion: 3 }))).toBe(
      'uses catalog format 3; update Orca to browse this catalog'
    )
    expect(pluginCatalogVersionError(catalog([]))).toBeNull()
    expect(
      pluginCatalogSchema.safeParse({ name: 'Acme', owner: 'acme', plugins: [] }).success
    ).toBe(false)
  })

  it('offers the newest release this Orca can install', () => {
    const releases = [
      release('3.0.0', '2.0.0'),
      release('2.0.0', '1.5.0'),
      release('1.0.0', '1.4.0')
    ]
    expect(selectPluginCatalogRelease(releases, '1.6.0')?.version).toBe('2.0.0')
    expect(selectPluginCatalogRelease(releases, '2.1.0')?.version).toBe('3.0.0')
    // Why the smallest: "Needs Orca X" should name the first Orca that unlocks anything.
    expect(selectPluginCatalogRelease(releases, '1.0.0')?.version).toBe('1.0.0')
    expect(
      selectPluginCatalogRelease([release('2.0.0', '9.0.0'), release('1.0.0', '8.0.0')], '1.0.0')
        ?.minimumOrca
    ).toBe('8.0.0')
  })

  it('exports a frozen v1 file that old clients accept', () => {
    const parsed = pluginCatalogSchema.parse(
      catalog([entry('acme.one', { description: 'One theme.' }), entry('acme.two')])
    )
    const legacy = legacyPluginCatalog({ ...parsed, plugins: parsed.plugins })
    expect(pluginMarketplaceSchema.safeParse(legacy).success).toBe(true)
    expect(legacy.plugins[0]).toEqual({
      id: 'acme.one',
      source: { kind: 'git', url: 'https://github.com/acme/acme.one.git', ref: 'main' },
      description: 'One theme.',
      categories: ['themes']
    })
  })
})
