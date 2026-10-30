import { describe, expect, it } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import {
  buildPluginListEntries,
  matchesPluginSearch,
  pluginListEntryFromListing
} from './plugin-list-entries'

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

  it('labels trust from the catalog address and names other catalogs without switching', () => {
    const community = { ...installed('acme.notes', 'Notes'), official: false }
    const plugin = fromCatalog(community, 'https://gitlab.com/acme/tools/catalog.git')
    const sources = [
      catalog('acme', 'https://gitlab.com/acme/tools/catalog.git'),
      catalog('mirror', 'https://github.com/mirror/c.git')
    ]
    const listings = [
      listing('acme.notes', {
        marketplaceSourceId: 'mirror',
        marketplaceName: 'Mirror',
        official: false,
        version: '9.0.0'
      }),
      listing('acme.notes', {
        marketplaceSourceId: 'acme',
        marketplaceName: 'Acme Plugins',
        official: false
      })
    ]
    const [joined] = buildPluginListEntries([plugin], listings, { sources }).installed
    expect(joined?.verifiedSource).toEqual({
      kind: 'catalog',
      catalog: 'Acme Plugins',
      owner: 'gitlab.com/acme/tools'
    })
    expect(joined?.alsoListedBy).toEqual(['Mirror'])
    expect(joined?.listing?.marketplaceSourceId).toBe('acme')
    expect(joined?.updateVersion).toBeNull()

    const [available] = buildPluginListEntries([], [listings[0]!], { sources }).available
    expect(available?.verifiedSource).toEqual({
      kind: 'catalog',
      catalog: 'Mirror',
      owner: 'github.com/mirror'
    })

    const sourceOf = (entry: PluginHostListEntry) =>
      buildPluginListEntries([entry], []).installed[0]?.verifiedSource
    expect(sourceOf({ ...community, isDev: true })).toEqual({ kind: 'dev' })
    expect(sourceOf(community)).toEqual({ kind: 'unverified' })
    expect(sourceOf(installed('stablyai.orca-notes', 'Notes'))).toEqual({ kind: 'official' })
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

  it('lists installed plugins once, joined to their listing, and the rest as available', () => {
    const result = buildPluginListEntries(
      [installed('stablyai.orca-midnight-theme', 'Orca Midnight')],
      [
        listing('stablyai.orca-midnight-theme'),
        listing('stablyai.orca-nord-theme'),
        listing('stablyai.orca-nord-theme', { marketplaceSourceId: 'mirror' })
      ]
    )
    expect(result.installed.map((entry) => [entry.name, entry.categories])).toEqual([
      ['Orca Midnight', ['themes']]
    ])
    expect(
      result.available.map((entry) => [entry.name, entry.listing?.marketplaceSourceId])
    ).toEqual([['Orca Nord Theme', 'official']])
  })

  it('names and versions a listing from its flat release fields, then the raw release', () => {
    const flat = pluginListEntryFromListing(
      listing('stablyai.orca-midnight-theme', { name: 'Orca Midnight', version: '2.0.0' })
    )
    expect(flat).toMatchObject({ name: 'Orca Midnight', version: '2.0.0' })
    const bare = pluginListEntryFromListing(listing('stablyai.orca-midnight-theme'))
    expect(bare.version).toBeNull()
    expect(bare.name).not.toBe('')
  })

  it('searches names, publishers, catalogs and categories', () => {
    const [entry] = buildPluginListEntries([], [listing('stablyai.orca-nord-theme')]).available
    expect(matchesPluginSearch(entry!, 'nord')).toBe(true)
    expect(matchesPluginSearch(entry!, 'THEMES')).toBe(true)
    expect(matchesPluginSearch(entry!, 'official plugins')).toBe(true)
    expect(matchesPluginSearch(entry!, 'gleam')).toBe(false)
    expect(matchesPluginSearch(entry!, '  ')).toBe(true)
  })
})
