import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PluginCategoryChips } from './PluginCategoryChips'
import { pluginListEntryFromListing, type PluginListEntry } from './plugin-list-entries'
import { NO_PLUGIN_LIST_FILTER, type PluginListFilter } from './plugin-list-filter'

function entry(pluginKey: string, categories: string[]): PluginListEntry {
  return pluginListEntryFromListing({
    marketplaceSourceId: 'community',
    marketplaceName: 'Orca Community Plugins',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c'.repeat(40),
    pluginKey,
    source: { kind: 'git', url: `https://github.com/${pluginKey}.git`, ref: 'main' },
    description: '',
    categories,
    official: false,
    bundled: false,
    name: pluginKey
  })
}

const entries = [
  entry('acme.dusk-theme', ['themes']),
  entry('acme.gleam-syntax', ['syntaxes']),
  entry('acme.zig-grammar', ['languages']),
  entry('acme.italiano', ['language-packs']),
  entry('acme.deutsch', ['localization']),
  entry('acme.mono-icons', ['icons']),
  entry('acme.csv-editor', ['editors']),
  entry('acme.port-watch', ['panels'])
]

function Chips({ selected }: { selected?: string }): React.JSX.Element {
  const [filter, setFilter] = useState<PluginListFilter>({
    ...NO_PLUGIN_LIST_FILTER,
    categories: new Set(selected ? [selected] : [])
  })
  return (
    <div className="p-4">
      <PluginCategoryChips entries={entries} filter={filter} onChange={setFilter} />
    </div>
  )
}

/** Every kind in a mixed catalog, code languages and translations as separate chips. */
export const allKinds = defineFixture({ width: 900, render: () => <Chips /> })

/** Translations picked: only language packs would list. */
export const translationsSelected = defineFixture({
  width: 900,
  render: () => <Chips selected="translations" />
})
