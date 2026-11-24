import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getAutomaticUpdatesSettingCopy(t: Translate = translate) {
  return {
    title: t('settings.automaticUpdates.title', 'Automatic updates'),
    description: t(
      'settings.automaticUpdates.description',
      'On supported desktop installs, Orca downloads eligible updates on its regular check schedule and restarts to install them automatically.'
    )
  }
}

export function getAutomaticUpdatesAwaySettingCopy(t: Translate = translate) {
  return {
    title: t('settings.automaticUpdates.waitUntilAway.title', "Wait until I'm away"),
    description: t(
      'settings.automaticUpdates.waitUntilAway.description',
      'Restart to install only after your screen locks or your computer has been idle for 10 minutes.'
    )
  }
}
