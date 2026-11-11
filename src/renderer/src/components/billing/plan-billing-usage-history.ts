// Pure helpers for Plan & billing's "Last 30 days": the chart's scale and labels, and the top
// workspaces and members with their names resolved. Hours use formatHours, like the meter above.
import type { Translate } from '@/i18n/use-translate'
import type { OrcaBillingUsageHistory, OrcaBillingUsageTop } from '../../../../shared/orca-billing'
import { formatHours } from './plan-billing-format'

const HOUR = 3600

// Axis tops whose half is also a clean tick (0 / mid / max), × a power of ten.
const NICE_TOPS = [1, 2, 3, 4, 5, 6, 8, 10]

/** The y-axis top in hours: the nearest clean value at or above the busiest day (min 1). */
export function usageChartMaxHours(days: OrcaBillingUsageHistory['days']): number {
  const busiest = Math.max(0, ...days.map((day) => day.seconds)) / HOUR
  if (busiest <= 1) {
    return 1
  }
  const power = 10 ** Math.floor(Math.log10(busiest))
  const top = NICE_TOPS.find((step) => busiest <= step * power) ?? 10
  return top * power
}

/** A bar's height as a share of the axis (0..100); a day with any usage stays visible (2%). */
export function usageBarPercent(seconds: number, maxHours: number): number {
  if (seconds <= 0) {
    return 0
  }
  return Math.min(100, Math.max(2, (seconds / HOUR / maxHours) * 100))
}

export type UsageBreakdownRow = {
  key: string
  label: string
  seconds: number
  /** Share of the team's 30-day hours, 0..100, for the row's thin bar. */
  share: number
  /** True for the "N others" line. */
  other?: boolean
}

export type UsageNames = {
  /** Display names by member id (the team roster). */
  members: ReadonlyMap<string, string>
  /** Workspace titles by sandbox id (the team's cloud workspace list). */
  workspaces: ReadonlyMap<string, string>
  /** The viewer's member id: their row reads "You". */
  selfId: string | null
}

function share(seconds: number, total: number): number {
  return total > 0 ? Math.min(100, (seconds / total) * 100) : 0
}

function rows(
  top: OrcaBillingUsageTop,
  total: number,
  /** The row's name, or null for an id that's no longer known (one merged row for all of them). */
  label: (id: string) => string | null,
  unknownLabel: (count: number) => string,
  othersLabel: (count: number) => string
): UsageBreakdownRow[] {
  const list: UsageBreakdownRow[] = []
  let unknown = { count: 0, seconds: 0 }
  let others = { count: top.otherCount, seconds: top.otherSeconds }
  for (const row of top.top) {
    // A row that shows as 0 hours says nothing on its own: it joins the others line.
    if (formatHours(row.seconds) === '0') {
      others = { count: others.count + 1, seconds: others.seconds + row.seconds }
      continue
    }
    const name = label(row.id)
    if (name === null) {
      unknown = { count: unknown.count + 1, seconds: unknown.seconds + row.seconds }
    } else {
      list.push({
        key: row.id,
        label: name,
        seconds: row.seconds,
        share: share(row.seconds, total)
      })
    }
  }
  // Named rows lead (they're what someone acts on); the merged unknowns always come after them.
  list.sort((a, b) => b.seconds - a.seconds)
  if (unknown.count > 0) {
    list.push({
      key: 'unknown',
      label: unknownLabel(unknown.count),
      seconds: unknown.seconds,
      share: share(unknown.seconds, total)
    })
  }
  if (others.seconds > 0) {
    list.push({
      key: 'other',
      label: othersLabel(others.count),
      seconds: others.seconds,
      share: share(others.seconds, total),
      other: true
    })
  }
  return list
}

export function topMemberRows(
  history: OrcaBillingUsageHistory,
  names: UsageNames,
  t: Translate
): UsageBreakdownRow[] | null {
  if (!history.members) {
    return null
  }
  return rows(
    history.members,
    history.totalSeconds,
    (id) =>
      id === names.selfId
        ? t('auto.components.billing.usage.you', 'You')
        : (names.members.get(id) ?? null),
    (count) =>
      t('auto.components.billing.usage.formerMembers', '{{count}} former members', {
        count,
        defaultValue_one: 'Former member'
      }),
    (count) =>
      count > 0
        ? t('auto.components.billing.usage.otherMembers', '{{count}} others', {
            count,
            defaultValue_one: '{{count}} other'
          })
        : t('auto.components.billing.usage.unattributed', 'Not attributed to a member')
  )
}

export function topWorkspaceRows(
  history: OrcaBillingUsageHistory,
  names: UsageNames,
  t: Translate
): UsageBreakdownRow[] | null {
  if (!history.sandboxes) {
    return null
  }
  return rows(
    history.sandboxes,
    history.totalSeconds,
    (id) => names.workspaces.get(id) ?? null,
    (count) =>
      t('auto.components.billing.usage.deletedWorkspaces', '{{count}} deleted workspaces', {
        count,
        defaultValue_one: 'Deleted workspace'
      }),
    (count) =>
      t('auto.components.billing.usage.otherWorkspaces', '{{count}} other workspaces', {
        count,
        defaultValue_one: '{{count}} other workspace'
      })
  )
}

/** "48 sandbox hours in 30 days": the chart's total, distinct from the month's meter above. */
export function usageWindowTotalLine(seconds: number, t: Translate): string {
  return t('auto.components.billing.usage.windowTotal', '{{value}} sandbox hours in 30 days', {
    value: formatHours(seconds),
    count: Number(formatHours(seconds)),
    defaultValue_one: '{{value}} sandbox hour in 30 days'
  })
}

/** "41.5 sandbox hours" (a day's readout). */
export function usageTotalLine(seconds: number, t: Translate): string {
  return t('auto.components.billing.usage.total', '{{value}} sandbox hours', {
    value: formatHours(seconds),
    count: Number(formatHours(seconds)),
    defaultValue_one: '{{value}} sandbox hour'
  })
}

/** A member's line: "You used 5 of your team's 41.5 sandbox hours." */
export function yourUsageLine(history: OrcaBillingUsageHistory, t: Translate): string {
  return t(
    'auto.components.billing.usage.yours',
    'You used {{yours}} of your team’s {{total}} sandbox hours.',
    {
      yours: formatHours(history.yourSeconds),
      total: formatHours(history.totalSeconds)
    }
  )
}

/** The bar's readout (tooltip, live region and table): "Nov 3 · 2.5 sandbox hours". */
export function usageDayLine(
  day: OrcaBillingUsageHistory['days'][number],
  locale: string,
  t: Translate
): string {
  return t('auto.components.billing.usage.dayLine', '{{date}} · {{hours}}', {
    date: usageDayLabel(day.start, locale),
    hours: usageTotalLine(day.seconds, t)
  })
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric'
}

export function usageDayLabel(start: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, DAY_FORMAT).format(start)
}
