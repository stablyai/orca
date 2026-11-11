import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  reviewRefreshIntervalMs,
  type PRAutoRefreshCadence
} from '../../../../../shared/review-refresh-policy'
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
    'How often pull request and checks status is re-read on a timer. Selecting a workspace, pushing, returning to the window and refreshing manually always read at once. On a server, this also caps how often connected clients can make it refresh.'
  )
}

export function getPRAutoRefreshCadenceLabel(
  cadence: PRAutoRefreshCadence,
  t: Translate = translate
): string {
  switch (cadence) {
    case 'default':
      return t('auto.components.settings.GitPane.prAutoRefreshDefault', 'Default')
    case 'reduced':
      return t('auto.components.settings.GitPane.prAutoRefreshReduced', 'Reduced')
    case 'minimal':
      return t('auto.components.settings.GitPane.prAutoRefreshMinimal', 'Minimal')
    case 'off':
      return t('auto.components.settings.GitPane.prAutoRefreshOff', 'Off')
  }
}

function formatEveryMinutes(ms: number, t: Translate): string {
  const minutes = Math.round(ms / 60_000)
  return minutes === 1
    ? t('auto.components.settings.GitPane.prAutoRefreshEveryMinute', 'every minute')
    : t('auto.components.settings.GitPane.prAutoRefreshEveryMinutes', 'every {{minutes}} min', {
        minutes
      })
}

/** What the selected cadence means in practice, derived from the shared policy so the hint can
 *  never drift from the intervals Orca actually uses. */
export function getPRAutoRefreshCadenceHint(
  cadence: PRAutoRefreshCadence,
  t: Translate = translate
): string {
  const mode = getPRAutoRefreshCadenceLabel(cadence, t)
  const open = reviewRefreshIntervalMs({ selected: true }, cadence)
  const visible = reviewRefreshIntervalMs({ selected: false }, cadence)
  if (open === null || visible === null) {
    return t(
      'auto.components.settings.GitPane.prAutoRefreshHintOff',
      '{{mode}}: no timed refresh. Orca still reads when you select a workspace, push, return to the window or refresh manually.',
      { mode }
    )
  }
  return t(
    'auto.components.settings.GitPane.prAutoRefreshHint',
    '{{mode}}: about {{open}} for the open workspace and {{visible}} for other visible ones.',
    { mode, open: formatEveryMinutes(open, t), visible: formatEveryMinutes(visible, t) }
  )
}

export function getPRAutoRefreshHostNote(hostName: string, t: Translate = translate): string {
  return t(
    'auto.components.settings.GitPane.prAutoRefreshHostNote',
    'Applies to {{host}} and every client connected to it.',
    { host: hostName }
  )
}

export function prAutoRefreshMatchesSearch(searchQuery: string, t?: Translate): boolean {
  return matchesSettingsSearch(searchQuery, {
    title: getPRAutoRefreshTitle(t),
    description: getPRAutoRefreshDescription(t),
    keywords: PR_AUTO_REFRESH_KEYWORDS
  })
}
