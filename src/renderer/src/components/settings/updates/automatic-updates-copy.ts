import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getAutomaticUpdatesSettingCopy(t: Translate = translate) {
  return {
    title: t('settings.automaticUpdates.title', 'Automatic updates'),
    description: t(
      'settings.automaticUpdates.description',
      'Download desktop updates in the background and install them when you quit Orca.'
    )
  }
}
