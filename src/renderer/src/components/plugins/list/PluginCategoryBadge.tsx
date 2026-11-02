import { createElement } from 'react'
import { Badge } from '../../ui/badge'
import { pluginCategoryLabel } from './plugin-category-label'
import { pluginCategoryIcon, pluginEntryCategoryIcon } from './plugin-category-icons'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginFilterKinds } from './plugin-list-filter'

/** A category's icon, for places that show a category without a plugin. */
export function PluginCategoryIcon({ category }: { category: string }): React.JSX.Element {
  return createElement(pluginCategoryIcon(category), { 'aria-hidden': true })
}

function KindBadge({ entry, kind }: { entry: PluginListEntry; kind: string }): React.JSX.Element {
  return (
    <Badge variant="hostContext">
      {createElement(pluginEntryCategoryIcon(entry, kind), { 'aria-hidden': true })}
      {pluginCategoryLabel(kind)}
    </Badge>
  )
}

/** What kind of plugin this is, as a chip with its icon; nothing when the kind is unknown. */
export function PluginCategoryBadge({
  entry
}: {
  entry: PluginListEntry
}): React.JSX.Element | null {
  const [kind] = pluginFilterKinds(entry)
  return kind ? <KindBadge entry={entry} kind={kind} /> : null
}

/** Every kind a plugin belongs to, as chips; the plugin page lists them all. */
export function PluginCategoryBadges({
  entry
}: {
  entry: PluginListEntry
}): React.JSX.Element | null {
  const kinds = [...pluginFilterKinds(entry)]
  if (kinds.length === 0) {
    return null
  }
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {kinds.map((kind) => (
        <KindBadge key={kind} entry={entry} kind={kind} />
      ))}
    </span>
  )
}
