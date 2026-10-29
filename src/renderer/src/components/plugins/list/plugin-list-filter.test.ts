import { describe, expect, it } from 'vitest'
import type { PluginListEntry } from './plugin-list-entries'
import { matchesPluginFilter, pluginFilterCategories } from './plugin-list-filter'

function entry(
  categories: string[],
  sourceId: string | null,
  catalogIds: string[] = sourceId ? [sourceId] : []
): PluginListEntry {
  return {
    pluginKey: `p.${categories.join('-')}`,
    name: 'P',
    publisher: null,
    version: null,
    description: null,
    official: false,
    categories,
    types: [],
    minimumOrca: null,
    updateVersion: null,
    catalogIds,
    updatable: false,
    autoUpdate: { updatedTo: null, needsReview: false },
    installed: null,
    listing: sourceId
      ? {
          marketplaceSourceId: sourceId,
          marketplaceName: 'Catalog',
          marketplaceOwner: 'owner',
          marketplaceCommit: 'c',
          pluginKey: 'p',
          source: { kind: 'git', url: 'https://example.invalid/c.git', ref: 'main' },
          categories,
          official: false,
          bundled: false
        }
      : null,
    verifiedSource: { kind: 'unverified' },
    alsoListedBy: []
  }
}

describe('plugin list filter', () => {
  it('counts categories without the trust label, and matches category and catalog together', () => {
    const themes = entry(['themes', 'official'], 'official')
    const icons = entry(['icons'], 'acme')
    expect(pluginFilterCategories([themes, icons])).toEqual([
      ['themes', 1],
      ['icons', 1]
    ])
    const filter = { categories: new Set(['themes']), sourceIds: new Set(['official']) }
    expect(matchesPluginFilter(themes, filter)).toBe(true)
    expect(matchesPluginFilter(icons, filter)).toBe(false)
    expect(matchesPluginFilter(entry(['themes'], null), filter)).toBe(false)
    expect(matchesPluginFilter(icons, { categories: new Set(), sourceIds: new Set() })).toBe(true)
  })

  it('folds catalog categories into readable kinds and keeps unknown ones', () => {
    const terminal = entry(['terminal-themes'], 'official')
    const recipes = entry(['vm-recipes'], 'official')
    const odd = entry(['music'], 'official')
    expect(pluginFilterCategories([terminal, recipes, odd])).toEqual([
      ['themes', 1],
      ['machines', 1],
      ['music', 1]
    ])
    expect(
      matchesPluginFilter(terminal, { categories: new Set(['themes']), sourceIds: new Set() })
    ).toBe(true)
  })

  it('matches a plugin under any catalog that lists it', () => {
    const shared = entry(['themes'], 'official', ['official', 'acme'])
    expect(
      matchesPluginFilter(shared, { categories: new Set(), sourceIds: new Set(['acme']) })
    ).toBe(true)
  })
})
