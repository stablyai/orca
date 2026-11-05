import { translate } from '@/i18n/i18n'

export function getAutoDownloadUpdatesTitle(): string {
  return translate('settings.autoDownloadUpdates.title', 'Download Updates Automatically')
}

export function getAutoDownloadUpdatesDescription(): string {
  return translate(
    'settings.autoDownloadUpdates.description',
    'Orca downloads new versions in the background. They install the next time you quit, or restart to update sooner.'
  )
}
