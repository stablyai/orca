import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
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
  return t('auto.components.settings.GitPane.prAutoRefreshTitle', 'PR Auto-Refresh')
}

export function getPRAutoRefreshDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.GitPane.prAutoRefreshDescription',
    'How often this host re-reads pull request and checks status on a timer. Default refreshes the selected workspace every minute and other visible ones every 2 minutes; Reduced uses 5 and 10 minutes; Minimal uses 10 and 20 minutes; Off only refreshes when you select a workspace, push, return to the window, or refresh manually. On a server, this also limits how often connected clients can make it refresh.'
  )
}

export function prAutoRefreshMatchesSearch(searchQuery: string, t?: Translate): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getPRAutoRefreshTitle(t),
    description: getPRAutoRefreshDescription(t),
    keywords: PR_AUTO_REFRESH_KEYWORDS
  })
}
