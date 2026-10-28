import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export function getBrowserPasswordsTitle(): string {
  return translate('settings.browser.passwords.title', 'Passwords')
}

export function getBrowserPasswordsDescription(): string {
  return translate(
    'settings.browser.passwords.description',
    'Saved logins for Orca’s browser: add, import, edit and delete them.'
  )
}

export function getBrowserPasswordsSearchEntry(): SettingsSearchEntry {
  return {
    title: getBrowserPasswordsTitle(),
    description: getBrowserPasswordsDescription(),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.passwords', 'passwords'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.logins', 'logins'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.autofill', 'autofill'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.import', 'import'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.csv', 'csv'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.vault', 'vault'),
      ...translateSearchKeyword('settings.browser.passwords.searchKeywords.touchId', 'touch id')
    ]
  }
}
