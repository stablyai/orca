// @protected-copy: the Official provenance badge.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function pluginOfficialLabel(t: Translate = translate): string {
  return t('auto.components.pluginCatalog.PluginListRow.official', 'Official')
}
