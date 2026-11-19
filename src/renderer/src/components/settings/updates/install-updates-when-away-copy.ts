import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getInstallUpdatesWhenAwaySearchEntry(t: Translate = translate) {
  return {
    title: t('settings.installUpdatesWhenAway.title', "Install updates when you're away"),
    description: t(
      'settings.installUpdatesWhenAway.description',
      "Download updates in the background and restart to install them when your screen is locked or you've been away for 10 minutes. Orca waits while a restart would interrupt a chat or other work."
    ),
    keywords: [
      ...translateSearchKeyword('settings.installUpdatesWhenAway.keywordAutomatic', 'automatic'),
      ...translateSearchKeyword('settings.installUpdatesWhenAway.keywordIdle', 'idle')
    ]
  }
}
