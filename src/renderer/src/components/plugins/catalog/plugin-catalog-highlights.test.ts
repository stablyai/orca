import { describe, expect, it } from 'vitest'
import type { PluginMarketplaceHostListing } from '../../../../../preload/api-types'
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
  it('hides the row when no plugin has an estimated listing date', () => {
    expect(pickNewlyAddedPlugins([entry('acme.one'), entry('acme.two')], '1.4.256', NOW)).toEqual(
      []
    )
  })

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

  it('hides the row when the newest listing is over 30 days old', () => {
    expect(
      pickNewlyAddedPlugins([entry('acme.old', { addedAt: '2026-10-09T00:00:00.000Z' })], null, NOW)
    ).toEqual([])
  })

  it('offers up to nine, as the website does', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`acme.p${index}`, { addedAt: new Date(NOW - (index + 1) * 3_600_000).toISOString() })
    )

    expect(pickNewlyAddedPlugins(entries, null, NOW).map((item) => item.pluginKey)).toEqual(
      Array.from({ length: 9 }, (_, index) => `acme.p${index}`)
    )
  })
})
