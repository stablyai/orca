import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  hasOfficialPluginPublisher,
  splitQualifiedPluginKey
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import {
  pluginNameClashKeys,
  type PluginNameCandidate
} from '../../../../../shared/plugins/plugin-name-clashes'

export function pluginNameWithPublisher(
  name: string,
  publisher: string,
  t: Translate = translate
): string {
  return t(
    'auto.components.plugins.pluginNameDisambiguation.nameWithPublisher',
    '{{value0}} ({{value1}})',
    { value0: name, value1: publisher }
  )
}

/** Each item's name as a list shows it: a clashing non-official one gains " (publisher)". */
export function disambiguatedPluginNames(
  items: readonly PluginNameCandidate[],
  t?: Translate
): Map<string, string> {
  const clashing = pluginNameClashKeys(items)
  return new Map(
    items.map((item) => [
      item.key,
      clashing.has(item.key) && item.publisher
        ? pluginNameWithPublisher(item.name, item.publisher, t)
        : item.name
    ])
  )
}

/** The Orca-derived publisher in a plugin key; Orca's reserved one marks official content. */
function contentPublisher(pluginKey: string): Pick<PluginNameCandidate, 'publisher' | 'official'> {
  return {
    publisher: splitQualifiedPluginKey(pluginKey)?.publisher ?? null,
    official: hasOfficialPluginPublisher(pluginKey)
  }
}

/** Plugin content (a theme, icon theme, language pack) offered in one picker. */
export type PluginContentLabelItem = { id: string; pluginKey: string; label: string }

/**
 * Labels for one picker's plugin content. `plainLabels` are Orca's own choices in the same picker
 * (built-in themes), which keep their names, so a plugin entry sharing one shows its publisher.
 */
export function disambiguatedPluginContentLabels(
  items: readonly PluginContentLabelItem[],
  plainLabels: readonly string[] = [],
  t?: Translate
): Map<string, string> {
  return disambiguatedPluginNames(
    [
      ...plainLabels.map((label, index) => ({
        key: `\0built-in:${index}`,
        name: label,
        publisher: null,
        official: true
      })),
      ...items.map((item) => ({
        key: item.id,
        name: item.label,
        ...contentPublisher(item.pluginKey)
      }))
    ],
    t
  )
}

/** Plugin names for the plugins behind some content, keyed by plugin key. */
export function disambiguatedContentPluginNames(
  items: readonly { pluginKey: string; pluginName: string }[],
  t?: Translate
): Map<string, string> {
  const byPlugin = new Map(items.map((item) => [item.pluginKey, item.pluginName]))
  return disambiguatedPluginNames(
    [...byPlugin].map(([pluginKey, name]) => ({
      key: pluginKey,
      name,
      ...contentPublisher(pluginKey)
    })),
    t
  )
}

type NamedPluginEntry = Omit<PluginNameCandidate, 'key'> & {
  pluginKey: string
  nameShowsPublisher?: boolean
}

/** Installed and listed plugins sharing a name: the non-official ones show their publisher. */
export function withDisambiguatedPluginNames<Entry extends NamedPluginEntry>(
  lists: {
    installed: Entry[]
    available: Entry[]
  },
  t?: Translate
): { installed: Entry[]; available: Entry[] } {
  const names = disambiguatedPluginNames(
    [...lists.installed, ...lists.available].map((entry) => ({ ...entry, key: entry.pluginKey })),
    t
  )
  const rename = (entry: Entry): Entry => {
    const name = names.get(entry.pluginKey) ?? entry.name
    return name === entry.name ? entry : { ...entry, name, nameShowsPublisher: true }
  }
  return { installed: lists.installed.map(rename), available: lists.available.map(rename) }
}
