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
    'How often pull request and checks status is re-read on a timer. Selecting a workspace, pushing and refreshing manually always read at once, and returning to the window reads anything older than its Default interval. On a server, this also sets the timers of connected clients; clients on older Orca versions keep their Default timer.'
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
    // CI-line watches keep reading at Minimal under Off, so the hint names their interval.
    const watch = reviewRefreshIntervalMs({ checksStatus: 'pending', selected: false }, 'minimal')
    return t(
      'auto.components.settings.GitPane.prAutoRefreshHintOff',
      '{{mode}}: no routine timed refresh. Checks a chat is following are still read {{watch}}. Orca also reads when you select a workspace, push, return to the window or refresh manually.',
      { mode, watch: formatEveryMinutes(watch ?? 0, t) }
    )
  }
  return t(
    'auto.components.settings.GitPane.prAutoRefreshHint',
    '{{mode}}: up to {{open}} for the open workspace and {{visible}} for other visible ones; settled pull requests are read less often.',
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
