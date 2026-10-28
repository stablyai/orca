import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserPasswordsExperimentalSearchEntry = createLocalizedCatalog(
  (): SettingsSearchEntry => ({
    title: translate('settings.experimental.browserPasswords.title', 'Saved passwords'),
    description: translate(
      'settings.experimental.browserPasswords.description',
      'Orca’s browser offers to save a login after it works and fills it from a list under the field. Manage them in Settings › Browser › Passwords.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.passwords', 'passwords'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.autofill', 'autofill'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.vault', 'vault')
    ],
    targetSectionId: 'browser-passwords-experimental'
  })
)
