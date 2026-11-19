import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getAutomaticUpdatesSettingCopy(t: Translate = translate) {
  return {
    title: t('settings.automaticUpdates.title', 'Automatic updates'),
    description: t(
      'settings.automaticUpdates.description',
      'When a background check finds an update, Orca downloads it and restarts to install it automatically.'
    )
  }
}
