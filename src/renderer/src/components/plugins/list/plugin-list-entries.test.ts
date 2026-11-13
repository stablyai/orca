import { describe, expect, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type {
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api/plugin-host-api'
import { buildPluginListEntries } from './plugin-list-entries'

function listing(pluginKey: string, extra: Partial<PluginMarketplaceHostListing> = {}) {
  const value: PluginMarketplaceHostListing = {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca Official Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'abc123',
    pluginKey,
    source: { kind: 'git', url: 'https://example.invalid/plugins.git', ref: 'main' },
    description: 'A quiet dark theme.',
    categories: ['themes'],
    official: true,
    bundled: false,
    ...extra
  }
  return value
}

function installed(pluginKey: string, name: string): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name,
    version: '1.0.0',
    publisher: 'stablyai',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: true,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0
  }
}

function fromCatalog(plugin: PluginHostListEntry, catalogUrl: string): PluginHostListEntry {
  return {
    ...plugin,
    source: {
      kind: 'marketplace',
      reference: 'https://example.invalid/plugin.git',
      resolvedCommit: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      marketplace: { reference: catalogUrl, resolvedCommit: 'c'.repeat(40) }
    }
  }
}

function catalog(id: string, url: string): PluginMarketplaceHostSourceState {
  return {
    id,
    source: { kind: 'git', url, ref: 'main' },
    addedAt: 0,
    marketplace: null,
    stale: false,
    official: false
  }
}

describe('plugin list entries', () => {
  it("adds the publisher to a community plugin that shares an official one's name", () => {
    const community = {
      ...installed('vale-c.catppuccin', 'Catppuccin for Orca'),
      publisher: 'vale-c',
      official: false
    }
    const { installed: mine, available } = buildPluginListEntries(
      [community],
      [
        listing('stablyai.orca-catppuccin-theme', { name: 'Catppuccin for Orca' }),
        listing('vale-c.catppuccin', { name: 'Catppuccin for Orca', official: false })
      ]
    )
    expect(mine[0]?.name).toBe('Catppuccin for Orca (vale-c)')
    expect(mine[0]?.nameShowsPublisher).toBe(true)
    expect(available.map((entry) => entry.name)).toEqual(['Catppuccin for Orca'])
    expect(available[0]?.nameShowsPublisher).toBeUndefined()
  })

  it('joins an installed plugin to the catalog it came from, and updates only from there', () => {
    const plugin = fromCatalog(installed('acme.notes', 'Notes'), 'https://mirror.invalid/c.git')
    const sources = [
      catalog('official', 'https://official.invalid/c.git'),
      catalog('mirror', 'https://mirror.invalid/c.git')
    ]
    const listings = [
      listing('acme.notes', { version: '3.0.0' }),
      listing('acme.notes', { marketplaceSourceId: 'mirror', version: '2.0.0' })
    ]
    const [joined] = buildPluginListEntries([plugin], listings, { sources }).installed
    expect(joined?.listing?.marketplaceSourceId).toBe('mirror')
    expect(joined?.updateVersion).toBe('2.0.0')
    expect(joined?.catalogIds).toEqual(['official', 'mirror'])

    // Why: with its own catalog removed, another catalog's newer version is not an update to offer.
    const [orphan] = buildPluginListEntries([plugin], [listings[0]!], {
      sources: [sources[0]!]
    }).installed
    expect(orphan?.updateVersion).toBeNull()
    expect(orphan?.updatable).toBe(false)
  })

  it('shows what automatic updates did only while it still matches the installed version', () => {
    const plugin = fromCatalog(installed('acme.notes', 'Notes'), 'https://mirror.invalid/c.git')
    const sources = [catalog('mirror', 'https://mirror.invalid/c.git')]
    const newer = [listing('acme.notes', { marketplaceSourceId: 'mirror', version: '2.0.0' })]
    const autoUpdates = { updated: {}, needsReview: { 'acme.notes': '2.0.0' } }
    const [held] = buildPluginListEntries([plugin], newer, { sources, autoUpdates }).installed
    expect(held?.autoUpdate).toEqual({ updatedTo: null, needsReview: true })

    // Why: once the update is installed (or none is offered) "needs review" no longer applies.
    const same = [listing('acme.notes', { marketplaceSourceId: 'mirror', version: '1.0.0' })]
    const updated = { updated: { 'acme.notes': '1.0.0' }, needsReview: { 'acme.notes': '2.0.0' } }
    const [done] = buildPluginListEntries([plugin], same, {
      sources,
      autoUpdates: updated
    }).installed
    expect(done?.autoUpdate).toEqual({ updatedTo: '1.0.0', needsReview: false })
    const [stale] = buildPluginListEntries([{ ...plugin, version: '0.9.0' }], same, {
      sources,
      autoUpdates: updated
    }).installed
    expect(stale?.autoUpdate.updatedTo).toBeNull()
  })

  it('tells two catalogs at one URL apart by ref', () => {
    const base = fromCatalog(installed('acme.notes', 'Notes'), 'https://official.invalid/c.git')
    const plugin: PluginHostListEntry = {
      ...base,
      source: base.source && {
        ...base.source,
        marketplace: {
          reference: 'https://official.invalid/c.git',
          ref: 'beta',
          resolvedCommit: 'c'
        }
      }
    }
    const sources = [
      catalog('stable', 'https://official.invalid/c.git'),
      {
        ...catalog('beta', 'https://official.invalid/c.git'),
        source: { kind: 'git' as const, url: 'https://official.invalid/c.git', ref: 'beta' }
      }
    ]
    const listings = [
      listing('acme.notes', { marketplaceSourceId: 'stable', version: '3.0.0' }),
      listing('acme.notes', { marketplaceSourceId: 'beta', version: '2.0.0' })
    ]
    const [joined] = buildPluginListEntries([plugin], listings, { sources }).installed
    expect(joined?.listing?.marketplaceSourceId).toBe('beta')
    expect(joined?.updateVersion).toBe('2.0.0')
  })

  it('does not offer an update this Orca is too old to run', () => {
    const plugin = fromCatalog(installed('acme.notes', 'Notes'), 'https://official.invalid/c.git')
    const sources = [catalog('official', 'https://official.invalid/c.git')]
    const newer = listing('acme.notes', {
      version: '2.0.0',
      release: {
        version: '2.0.0',
        commit: 'd'.repeat(40),
        contentHash: 'e'.repeat(64),
        execution: 'data',
        minimumOrca: '2.0.0',
        types: []
      }
    })
    const build = (orcaVersion: string) =>
      buildPluginListEntries([plugin], [newer], { sources, orcaVersion }).installed[0]
    expect(build('1.9.0')?.updateVersion).toBeNull()
    expect(build('2.1.0')?.updateVersion).toBe('2.0.0')
  })

  it('offers a reinstall for an installed copy that cannot load only when the catalog has other bytes', () => {
    const plugin: PluginHostListEntry = {
      ...fromCatalog(installed('acme.notes', 'Notes'), 'https://official.invalid/c.git'),
      status: 'invalid'
    }
    const sources = [catalog('official', 'https://official.invalid/c.git')]
    const release = (contentHash: string, minimumOrca = '1.0.0') =>
      listing('acme.notes', {
        version: '1.0.0',
        release: {
          version: '1.0.0',
          commit: 'd'.repeat(40),
          contentHash,
          execution: 'data',
          minimumOrca,
          types: []
        }
      })
    const build = (offered: PluginMarketplaceHostListing, target = plugin) =>
      buildPluginListEntries([target], [offered], { sources, orcaVersion: '1.5.0' }).installed[0]
    expect(build(release('e'.repeat(64)))?.reinstallVersion).toBe('1.0.0')
    // Same bytes would fail the same way; a release this Orca can't run is no fix either.
    expect(build(release('b'.repeat(64)))?.reinstallVersion).toBeNull()
    expect(build(release('e'.repeat(64), '2.0.0'))?.reinstallVersion).toBeNull()
    expect(
      build(release('e'.repeat(64)), { ...plugin, status: 'running' })?.reinstallVersion
    ).toBeNull()
  })
})
