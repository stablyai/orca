// Settings-search entries for the Passwords pane. Kept in its own file to
// mirror the other per-pane search modules (privacy-search.ts, etc.) and
// keep Settings.tsx imports uniform.

import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getPasswordsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.passwords.search.title', 'Passwords'),
    description: translate(
      'auto.components.settings.passwords.search.description',
      'Saved logins for the built-in browser.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.passwords.search.kw_passwords',
        'passwords'
      ),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_logins', 'logins'),
      ...translateSearchKeyword(
        'auto.components.settings.passwords.search.kw_autofill',
        'autofill'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.passwords.search.kw_credentials',
        'credentials'
      ),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_browser', 'browser'),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_saved', 'saved'),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_vault', 'vault'),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_security', 'security')
    ]
  },
  {
    title: translate(
      'auto.components.settings.passwords.search.autofill_title',
      'Password Autofill'
    ),
    description: translate(
      'auto.components.settings.passwords.search.autofill_description',
      'Enable or disable automatic password filling in the built-in browser.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.passwords.search.kw_autofill',
        'autofill'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.passwords.search.kw_passwords',
        'passwords'
      ),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_enable', 'enable'),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_disable', 'disable'),
      ...translateSearchKeyword('auto.components.settings.passwords.search.kw_toggle', 'toggle')
    ]
  }
])
