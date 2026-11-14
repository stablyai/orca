import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getDynamicAccountLaunchSearchEntry(
  provider: 'claude' | 'codex',
  targetSectionId?: string
): SettingsSearchEntry {
  return {
    targetSectionId,
    title: translate('accounts.dynamicLaunch.title', 'Pick an account for each new session'),
    description: translate(
      'accounts.dynamicLaunch.description',
      'Uses the account whose weekly limit resets soonest, keeping a margin free on every account.'
    ),
    keywords: [
      ...(provider === 'claude'
        ? translateSearchKeyword('auto.components.settings.accounts.search.e14049e1a8', 'claude')
        : translateSearchKeyword('auto.components.settings.accounts.search.70d1b8def5', 'codex')),
      ...translateSearchKeyword('auto.components.settings.accounts.search.06662af91e', 'account'),
      ...translateSearchKeyword('accounts.dynamicLaunch.keyword.dynamic', 'dynamic'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota')
    ]
  }
}
