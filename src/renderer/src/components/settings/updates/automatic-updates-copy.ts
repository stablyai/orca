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

export function getAutomaticUpdateChecksSettingCopy(t: Translate = translate) {
  return {
    title: t('settings.automaticUpdateChecks.title', 'Check for updates automatically'),
    description: t(
      'settings.automaticUpdateChecks.description',
      'Orca checks for new versions at startup, on wake, and once a day. When off, Orca only checks when you click Check for updates.'
    )
  }
}
