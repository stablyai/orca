import { Code, Command, FolderTree, Languages, Palette, Server, Tag } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { pluginCategoryLabel } from './plugin-category-label'
import type { PluginListEntry } from './plugin-list-entries'
import { isPluginFilterKind, pluginFilterKinds, type PluginFilterKind } from './plugin-list-filter'

const KIND_ICON: Record<PluginFilterKind, typeof Palette> = {
  themes: Palette,
  icons: FolderTree,
  languages: Languages,
  commands: Command,
  machines: Server
}

/** A category's icon; the filter list and the card badges share it. */
export function PluginCategoryIcon({ category }: { category: string }): React.JSX.Element {
  const Icon = isPluginFilterKind(category) ? KIND_ICON[category] : Tag
  return <Icon aria-hidden="true" />
}

/** What kind of plugin this is, as a chip with its icon; nothing when the kind is unknown. */
export function PluginCategoryBadge({
  entry
}: {
  entry: PluginListEntry
}): React.JSX.Element | null {
  const [kind] = pluginFilterKinds(entry)
  if (!kind) {
    return null
  }
  // Why: syntax packs share the Languages category with interface languages but are for code.
  const forCode =
    kind === 'languages' &&
    entry.types.includes('syntax') &&
    !entry.types.includes('interface-language')
  return (
    <Badge variant="hostContext">
      {forCode ? <Code aria-hidden="true" /> : <PluginCategoryIcon category={kind} />}
      {pluginCategoryLabel(kind)}
    </Badge>
  )
}
