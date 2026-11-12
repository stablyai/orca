import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { pluginDisplayNameFromKey } from './plugin-display-name'
import { isPluginFilterKind, pluginFilterKinds, type PluginFilterKind } from './plugin-list-filter'

function kindLabel(kind: PluginFilterKind, t: Translate = translate): string {
  switch (kind) {
    case 'themes':
      return t('auto.components.settings.PluginFilterPopover.themes', 'Themes')
    case 'languages':
      return t('auto.components.settings.PluginFilterPopover.languages', 'Languages')
    case 'icons':
      return t('auto.components.settings.PluginFilterPopover.icons', 'Icons')
    case 'editors':
      return t('auto.components.settings.PluginFilterPopover.editors', 'Editors')
    case 'commands':
      return t('auto.components.settings.PluginFilterPopover.commands', 'Commands & panels')
    case 'machines':
      return t('auto.components.settings.PluginFilterPopover.remoteVms', 'Remote/VMs')
    case 'games':
      return t('auto.components.settings.PluginFilterPopover.games', 'Games')
  }
}

// Why: catalog categories that stand alone as chips but have a known name.
function standaloneCategoryLabel(category: string, t: Translate = translate): string | null {
  switch (category) {
    case 'games':
      return t('auto.components.settings.PluginFilterPopover.games', 'Games')
    case 'agents':
      return t('auto.components.settings.PluginFilterPopover.agents', 'Agents')
    case 'integrations':
      return t('auto.components.settings.PluginFilterPopover.integrations', 'Integrations')
    default:
      return null
  }
}

// Why: unknown catalog categories are slugs ("music-tools"); show them as words.
export function pluginCategoryLabel(category: string, t?: Translate): string {
  if (isPluginFilterKind(category)) {
    return kindLabel(category, t)
  }
  const standalone = standaloneCategoryLabel(category, t)
  if (standalone) {
    return standalone
  }
  const kinds = pluginFilterKinds({ categories: [category] })
  const [kind] = kinds
  return kind && isPluginFilterKind(kind) ? kindLabel(kind, t) : pluginDisplayNameFromKey(category)
}
