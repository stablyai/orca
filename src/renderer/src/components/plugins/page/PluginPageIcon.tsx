import type { PluginHostImage } from '../../../../../shared/plugins/images/plugin-image-url'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginRowArt } from '../list/PluginRowArt'

/** The header's app-icon tile: the plugin's verified icon, else what kind of plugin it is. */
export function PluginPageIcon({
  entry,
  icon
}: {
  entry: PluginListEntry
  icon: PluginHostImage | undefined
}): React.JSX.Element {
  if (!icon) {
    return <PluginRowArt entry={entry} size="page" />
  }
  return (
    <img
      src={icon.url}
      alt=""
      width={64}
      height={64}
      decoding="async"
      className="size-16 shrink-0 rounded-2xl border border-border/60 bg-muted object-cover"
    />
  )
}
