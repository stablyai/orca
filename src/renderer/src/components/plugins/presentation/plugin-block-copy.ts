// @protected-copy scope=file
import type { Translate } from '@/i18n/use-translate'
import type { PluginBlockNotice } from '../../../../../shared/plugins/catalog/plugin-kill-list'

export function pluginBlockCopy(block: PluginBlockNotice, t: Translate, installed = false): string {
  if (block.team) {
    return t('plugins.blockedByTeam', 'Blocked by your team.')
  }
  return installed
    ? t(
        'auto.components.settings.PluginSettingsRow.killListMessage',
        "Orca's safety list disabled this plugin: {{value0}}",
        { value0: block.reason }
      )
    : t(
        'auto.components.settings.PluginMarketplaceListingRow.blocked',
        "Blocked by Orca's safety list: {{value0}}",
        { value0: block.reason }
      )
}
