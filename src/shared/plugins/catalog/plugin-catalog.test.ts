import { describe, expect, it } from 'vitest'
import { legacyPluginCatalog } from '../../../../config/scripts/plugin-authoring/content-validation/export-legacy-plugin-catalog.mjs'
import { pluginCatalogSchema, selectPluginCatalogRelease } from './plugin-catalog'
import { pluginCatalogReleaseSchema } from './plugin-catalog-release'
import { pluginMarketplaceSchema } from './plugin-marketplace'

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
  it.each(['main', 'v1.0.0', 'a'.repeat(7), 'A'.repeat(40)])(
    'drops a release pinned to %s instead of a full commit SHA',
    (commit) => {
      const parsed = pluginCatalogSchema.parse(
        catalog([
          entry('acme.one', { releases: [{ ...release('2.0.0'), commit }, release('1.0.0')] })
        ])
      )
      expect(parsed.plugins[0]?.releases.map((item) => item.version)).toEqual(['1.0.0'])
    }
  )

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

  it('lists plugins from directories of one repository and refuses unsafe directories', () => {
    const at = (path: string, index: number) =>
      entry(`acme.p${index}`, {
        source: { kind: 'git', url: 'https://github.com/acme/plugins.git', ref: 'main', path }
      })
    const safe = ['gleam', 'plugins/gleam-syntax', 'a/b.c/d']
    const unsafe = ['', '../gleam', 'plugins/../gleam', '/plugins/gleam', 'plugins\\gleam']
    const more = ['C:/plugins', './gleam', 'plugins/./gleam', 'plugins/', 'plugins//gleam', 'nul']
    const parsed = pluginCatalogSchema.parse(catalog([...safe, ...unsafe, ...more].map(at)))
    expect(parsed.plugins.map((plugin) => plugin.source.path)).toEqual(safe)
  })

  it('leaves plugins in a repository directory out of the frozen v1 file', () => {
    const nested = entry('acme.two', {
      source: { kind: 'git', url: 'https://github.com/acme/plugins.git', ref: 'main', path: 'two' }
    })
    const parsed = pluginCatalogSchema.parse(catalog([entry('acme.one'), nested]))
    const legacy = legacyPluginCatalog(parsed)
    expect(legacy.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(['acme.one'])
    expect(
      pluginMarketplaceSchema.safeParse({
        ...legacy,
        plugins: [{ ...legacy.plugins[0], source: nested.source }]
      }).success
    ).toBe(false)
  })
})
