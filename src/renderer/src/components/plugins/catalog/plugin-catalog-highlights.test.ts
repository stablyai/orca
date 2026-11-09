import { describe, expect, it } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
import { pluginListEntryFromListing, type PluginListEntry } from '../list/plugin-list-entries'
import { matchesPluginFilter, NO_PLUGIN_LIST_FILTER } from '../list/plugin-list-filter'
import { pickFeaturedPlugins, pickNewlyAddedPlugins } from './plugin-catalog-highlights'

const NOW = Date.parse('2026-11-09T20:00:00Z')

function entry(
  pluginKey: string,
  extra: Partial<PluginMarketplaceHostListing> = {},
  overrides: Partial<PluginListEntry> = {}
): PluginListEntry {
  const listing: PluginMarketplaceHostListing = {
    marketplaceSourceId: 'community',
    marketplaceName: 'Orca Community Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'a'.repeat(40),
    pluginKey,
    source: { kind: 'git', url: `https://github.com/${pluginKey}.git`, ref: 'main' },
    categories: ['themes'],
    official: false,
    bundled: false,
    ...extra
  }
  return { ...pluginListEntryFromListing(listing), installCountEligible: true, ...overrides }
}

describe('pickFeaturedPlugins', () => {
  it('ranks by installs and keeps one plugin per kind', () => {
    const entries = [
      entry('acme.ayu'),
      entry('acme.catppuccin'),
      entry('acme.excalidraw', { categories: ['editors'] }),
      entry('acme.toolbox', { categories: ['panels'] })
    ]
    const counts = {
      'acme.ayu': 2467,
      'acme.catppuccin': 2134,
      'acme.excalidraw': 2384,
      'acme.toolbox': 422
    }

    expect(pickFeaturedPlugins(entries, counts, '1.4.256').map((item) => item.pluginKey)).toEqual([
      'acme.ayu',
      'acme.excalidraw',
      'acme.toolbox'
    ])
  })

  it('skips plugins that cannot be installed from the row', () => {
    const entries = [
      entry('acme.installed', {}, { installed: {} as PluginListEntry['installed'] }),
      entry('acme.blocked', { blockedByKillList: { reason: 'malware' } }),
      entry('acme.newer', {}, { minimumOrca: '9.0.0' }),
      entry('acme.local', {}, { installCountEligible: false }),
      entry('acme.ok')
    ]
    const counts = {
      'acme.installed': 900,
      'acme.blocked': 800,
      'acme.newer': 700,
      'acme.local': 600,
      'acme.ok': 10
    }

    expect(pickFeaturedPlugins(entries, counts, '1.4.256').map((item) => item.pluginKey)).toEqual([
      'acme.ok'
    ])
  })
})

describe('pickNewlyAddedPlugins', () => {
  it('hides the row when no catalog dates its entries', () => {
    expect(pickNewlyAddedPlugins([entry('acme.one'), entry('acme.two')], '1.4.256', NOW)).toBeNull()
  })

  it('lists the newest recent plugins first and counts the whole week', () => {
    const entries = [
      entry('acme.hour', { addedAt: '2026-11-09T19:00:00Z' }),
      entry('acme.days', { addedAt: '2026-11-06' }),
      entry('acme.minutes', { addedAt: '2026-11-09T19:50:00+00:00' }),
      entry(
        'acme.installed',
        { addedAt: '2026-11-09T18:00:00Z' },
        {
          installed: {} as PluginListEntry['installed']
        }
      ),
      entry('acme.stale', { addedAt: '2026-09-01' }),
      entry('acme.undated')
    ]

    const picked = pickNewlyAddedPlugins(entries, '1.4.256', NOW)

    expect(picked?.rows.map((item) => item.pluginKey)).toEqual([
      'acme.minutes',
      'acme.hour',
      'acme.days'
    ])
    expect(picked?.thisWeek).toBe(4)
  })

  it('hides the row when the newest listing is over two weeks old', () => {
    expect(
      pickNewlyAddedPlugins([entry('acme.old', { addedAt: '2026-10-20' })], null, NOW)
    ).toBeNull()
  })
})

describe('Added this week filter', () => {
  it('keeps only plugins listed in the last seven days', () => {
    const filter = { ...NO_PLUGIN_LIST_FILTER, addedThisWeek: true }

    expect(
      matchesPluginFilter(entry('acme.new', { addedAt: '2026-11-03T21:00:00Z' }), filter, NOW)
    ).toBe(true)
    expect(matchesPluginFilter(entry('acme.old', { addedAt: '2026-11-01' }), filter, NOW)).toBe(
      false
    )
    expect(matchesPluginFilter(entry('acme.undated'), filter, NOW)).toBe(false)
  })
})
