import { describe, expect, it } from 'vitest'
import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api-types'
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
