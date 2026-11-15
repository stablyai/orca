import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { PRAutoRefreshCadence } from '../../../../../shared/review-refresh-policy'
import { matchesSettingsSearch } from '../search/settings-search'

export const PR_AUTO_REFRESH_KEYWORDS = [
  'pull request',
  'pr',
  'checks',
  'polling',
  'refresh interval',
  'background refresh',
  'github enterprise',
  'cpu',
  'gh'
]

export function getPRAutoRefreshTitle(t: Translate = translate): string {
  return t('auto.components.settings.GitPane.prAutoRefreshTitle', 'PR Updates')
}

export function getPRAutoRefreshDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.GitPane.prAutoRefreshDescription',
    'How often Orca checks GitHub for pull request and CI changes.'
  )
}

export function getPRAutoRefreshCadenceLabel(
  cadence: PRAutoRefreshCadence,
  t: Translate = translate
): string {
  switch (cadence) {
    case 'default':
      return t('auto.components.settings.GitPane.prAutoRefreshDefault', 'Automatic')
    case 'minimal':
    case 'reduced':
      return t('auto.components.settings.GitPane.prAutoRefreshReduced', 'Less often')
    case 'off':
      return t('auto.components.settings.GitPane.prAutoRefreshOff', 'Manual')
  }
}

export function getPRAutoRefreshCadenceHint(
  cadence: PRAutoRefreshCadence,
  t: Translate = translate
): string {
  switch (cadence) {
    case 'default':
      return t(
        'auto.components.settings.GitPane.prAutoRefreshHintAutomatic',
        'Keeps pull requests and checks up to date.'
      )
    case 'minimal':
    case 'reduced':
      return t(
        'auto.components.settings.GitPane.prAutoRefreshHintLessOften',
        'Checks GitHub less often. Useful if you hit GitHub rate limits.'
      )
    case 'off':
      return t(
        'auto.components.settings.GitPane.prAutoRefreshHintOff',
        'Updates when you push or click Refresh.'
      )
  }
}

export function prAutoRefreshMatchesSearch(searchQuery: string, t?: Translate): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getPRAutoRefreshTitle(t),
    description: getPRAutoRefreshDescription(t),
    keywords: PR_AUTO_REFRESH_KEYWORDS
  })
}
