import { translate } from '@/i18n/i18n'
import { pluginDisplayNameFromKey } from './plugin-display-name'
import { isPluginFilterKind, pluginFilterKinds, type PluginFilterKind } from './plugin-list-filter'

function kindLabel(kind: PluginFilterKind): string {
  switch (kind) {
    case 'themes':
      return translate('auto.components.settings.PluginFilterPopover.themes', 'Themes')
    case 'languages':
      return translate('auto.components.settings.PluginFilterPopover.languages', 'Languages')
    case 'icons':
      return translate('auto.components.settings.PluginFilterPopover.icons', 'Icons')
    case 'editors':
      return translate('auto.components.settings.PluginFilterPopover.editors', 'Editors')
    case 'commands':
      return translate('auto.components.settings.PluginFilterPopover.commands', 'Commands & panels')
    case 'machines':
      return translate('auto.components.settings.PluginFilterPopover.remoteVms', 'Remote/VMs')
  }
}

// Why: unknown catalog categories are slugs ("music-tools"); show them as words.
export function pluginCategoryLabel(category: string): string {
  if (isPluginFilterKind(category)) {
    return kindLabel(category)
  }
  const kinds = pluginFilterKinds({ categories: [category] })
  const [kind] = kinds
  return kind && isPluginFilterKind(kind) ? kindLabel(kind) : pluginDisplayNameFromKey(category)
}
