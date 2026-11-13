import { describe, expect, it } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginListEntryFromListing, type PluginListEntry } from '../list/plugin-list-entries'
import { pickFeaturedPlugins, pickNewlyAddedPlugins } from './plugin-catalog-highlights'

const NOW = Date.parse('2026-11-09T20:00:00Z')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows only check that an installed record exists, never read it.
const INSTALLED = {} as PluginListEntry['installed']

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
    source: {
      kind: 'git',
      url: `https://github.com/${pluginKey}.git`,
      ref: 'main'
    },
    categories: ['themes'],
    official: false,
    bundled: false,
    ...extra
  }
  return {
    ...pluginListEntryFromListing(listing),
    installCountEligible: true,
    ...overrides
  }
}

describe('pickFeaturedPlugins', () => {
  it('counts every kind a plugin belongs to, whatever order its categories come in', () => {
    const counts = { 'acme.multi': 100, 'acme.editor': 90 }
    for (const categories of [
      ['themes', 'editors'],
      ['editors', 'themes']
    ]) {
      const entries = [
        entry('acme.multi', { categories }),
        entry('acme.editor', { categories: ['editors'] })
      ]

      expect(pickFeaturedPlugins(entries, counts, null).map((item) => item.pluginKey)).toEqual([
        'acme.multi',
        'acme.editor'
      ])
    }
  })

  it('picks the same plugins whatever order the catalog and categories come in', () => {
    const counts = {
      'acme.multi': 100,
      'acme.editor': 90,
      'acme.theme': 80,
      'acme.game': 50,
      'acme.tie-b': 40,
      'acme.tie-a': 40
    }
    const build = (reverse: boolean): PluginListEntry[] => {
      const order = <T>(items: T[]): T[] => (reverse ? items.toReversed() : items)
      return order([
        entry('acme.multi', {
          categories: order(['themes', 'editors', 'games'])
        }),
        entry('acme.editor', { categories: ['editors'] }),
        entry('acme.theme', { categories: ['themes'] }),
        entry('acme.game', { categories: order(['games', 'editors']) }),
        entry('acme.tie-b', { categories: ['panels'] }),
        entry('acme.tie-a', { categories: ['panels'] })
      ])
    }

    const forward = pickFeaturedPlugins(build(false), counts, null).map((item) => item.pluginKey)
    const reversed = pickFeaturedPlugins(build(true), counts, null).map((item) => item.pluginKey)

    expect(reversed).toEqual(forward)
    expect(forward).toEqual(['acme.multi', 'acme.editor', 'acme.theme', 'acme.tie-a'])
  })

  it('skips plugins that cannot be installed from the row', () => {
    const entries = [
      entry('acme.installed', {}, { installed: INSTALLED }),
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
  it('lists the newest installable plugins first, inside the 30-day window', () => {
    const entries = [
      entry('acme.hour', { addedAt: '2026-11-09T19:00:00.000Z' }),
      entry('acme.days', { addedAt: '2026-11-06T00:00:00.000Z' }),
      entry('acme.minutes', { addedAt: '2026-11-09T19:50:00.000Z' }),
      entry('acme.installed', { addedAt: '2026-11-09T18:00:00.000Z' }, { installed: INSTALLED }),
      entry('acme.weeks', { addedAt: '2026-10-25T00:00:00.000Z' }),
      entry('acme.month', { addedAt: '2026-10-12T00:00:00.000Z' }),
      entry('acme.stale', { addedAt: '2026-09-01T00:00:00.000Z' }),
      entry('acme.future', { addedAt: '2026-11-12T00:00:00.000Z' }),
      entry('acme.undated')
    ]

    const picked = pickNewlyAddedPlugins(entries, '1.4.256', NOW)

    expect(picked.map((item) => item.pluginKey)).toEqual([
      'acme.minutes',
      'acme.hour',
      'acme.days',
      'acme.weeks',
      'acme.month'
    ])
  })
})
