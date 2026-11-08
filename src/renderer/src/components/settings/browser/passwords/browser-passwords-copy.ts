import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsSearchEntry } from '../../search/settings-search'
import { translateSearchKeyword } from '../../search/settings-search-keywords'

export function getBrowserPasswordsTitle(t: Translate = translate): string {
  return t('settings.browser.passwords.title', 'Passwords')
}

export function getBrowserPasswordsDescription(t: Translate = translate): string {
  return t(
    'settings.browser.passwords.description',
    'Saved logins for Orca’s browser: add, import, edit and delete them.'
  )
}

export function getBrowserPasswordsSearchEntry(t?: Translate): SettingsSearchEntry {
  return {
    title: getBrowserPasswordsTitle(t),
    description: getBrowserPasswordsDescription(t),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.browser.search.2d2d995c58',
        'browser',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.passwords',
        'passwords',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.logins',
        'logins',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.autofill',
        'autofill',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.import',
        'import',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.csv',
        'csv',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.vault',
        'vault',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.browser.passwords.searchKeywords.touchId',
        'touch id',
        undefined,
        t
      )
    ]
  }
}
