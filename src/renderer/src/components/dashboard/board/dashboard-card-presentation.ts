import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export const DASHBOARD_ATTENTION_SURFACE_CLASS =
  'border-agent-question/40 bg-agent-question/[0.06] hover:border-agent-question/60 hover:bg-agent-question/10'

/** Tint only attention and done so scan-worthy outcomes retain distinct meaning. */
export function dashboardCardSurfaceClass(card: DashboardCard): string {
  if (card.bucket === 'attention') {
    return DASHBOARD_ATTENTION_SURFACE_CLASS
  }
  return dashboardCardDisplayState(card) === 'done'
    ? 'border-emerald-500/40 bg-emerald-500/[0.06] hover:border-emerald-500/60 hover:bg-emerald-500/10'
    : 'border-border/60 bg-card hover:border-border hover:bg-accent/40'
}

function formatStartedAgo(startedAt: number, now: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) {
    return t('dashboardPopout.card.time.justNow', 'just now')
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t('dashboardPopout.card.time.minutes', '{{count}}m', { count: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t('dashboardPopout.card.time.hours', '{{count}}h', { count: hours })
  }
  return t('dashboardPopout.card.time.days', '{{count}}d', {
    count: Math.floor(hours / 24)
  })
}

/** Count from completion when present, otherwise start, matching the worktree sidebar; null when neither is known. */
export function dashboardCardAgeLabel(
  card: DashboardCard,
  now: number,
  t: Translate = translate
): string | null {
  const timestamp = card.finishedAt ?? card.startedAt
  return timestamp > 0 ? formatStartedAgo(timestamp, now, t) : null
}
