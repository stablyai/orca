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

export type DashboardCardAgeBucket =
  | { unit: 'justNow'; count: 0 }
  | { unit: 'minutes' | 'hours' | 'days'; count: number }

function ageBucketSince(startedAt: number, now: number): DashboardCardAgeBucket {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) {
    return { unit: 'justNow', count: 0 }
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return { unit: 'minutes', count: minutes }
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return { unit: 'hours', count: hours }
  }
  return { unit: 'days', count: Math.floor(hours / 24) }
}

/** Count from completion when present, otherwise start, matching the worktree sidebar; null when neither is known. */
export function dashboardCardAgeBucket(
  card: DashboardCard,
  now: number
): DashboardCardAgeBucket | null {
  const timestamp = card.finishedAt ?? card.startedAt
  return timestamp > 0 ? ageBucketSince(timestamp, now) : null
}

export function formatDashboardCardAge(age: DashboardCardAgeBucket, t: Translate): string {
  switch (age.unit) {
    case 'justNow':
      return t('dashboardPopout.card.time.justNow', 'just now')
    case 'minutes':
      return t('dashboardPopout.card.time.minutes', '{{count}}m', { count: age.count })
    case 'hours':
      return t('dashboardPopout.card.time.hours', '{{count}}h', { count: age.count })
    case 'days':
      return t('dashboardPopout.card.time.days', '{{count}}d', { count: age.count })
  }
}

export function dashboardCardAgeLabel(
  card: DashboardCard,
  now: number,
  t: Translate = translate
): string | null {
  const age = dashboardCardAgeBucket(card, now)
  return age ? formatDashboardCardAge(age, t) : null
}
