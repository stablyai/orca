import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { formatUiAutomationSchedule } from '@/components/automations/automation-schedule-label'
import {
  CLOUD_API_ADMIN_SCOPES,
  CLOUD_API_SCOPES,
  CLOUD_API_READ_SCOPES,
  type CloudApiScope,
  type RoutineGithubEvent,
  type RoutineTrigger
} from '../../../../../shared/cloud-api/cloud-api-types'

export type ScopePreset = 'read' | 'full' | 'custom'

/** Read only = every *:read scope the viewer may grant; Full = everything they may grant. */
export function scopesForPreset(
  preset: Exclude<ScopePreset, 'custom'>,
  available: readonly CloudApiScope[]
): CloudApiScope[] {
  if (preset === 'full') {
    return [...available]
  }
  return available.filter((scope) => CLOUD_API_READ_SCOPES.includes(scope))
}

export function presetForScopes(
  scopes: readonly CloudApiScope[],
  available: readonly CloudApiScope[]
): ScopePreset {
  const set = new Set(scopes)
  const same = (other: readonly CloudApiScope[]): boolean =>
    other.length === set.size && other.every((scope) => set.has(scope))
  if (same(scopesForPreset('full', available))) {
    return 'full'
  }
  if (same(scopesForPreset('read', available))) {
    return 'read'
  }
  return 'custom'
}

export function isAdminScope(scope: CloudApiScope): boolean {
  return CLOUD_API_ADMIN_SCOPES.includes(scope)
}

/** "orca_sk_Ab3x…" — the stored prefix plus an ellipsis so nobody mistakes it for the secret. */
export function formatKeyPrefix(prefix: string): string {
  return `${prefix}…`
}

export function formatRelativeFromNow(timestamp: number, now: number, intlLocale?: string): string {
  return formatUiRelativeTime(timestamp - now, intlLocale)
}

export function formatAbsoluteTime(timestamp: number, intlLocale?: string): string {
  return new Intl.DateTimeFormat(intlLocale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    timestamp
  )
}

/** Run durations and live elapsed time share the app's one "1m 42s" format. */
export function formatRunDuration(ms: number | null): string {
  return ms === null ? '—' : formatElapsedTime(ms)
}

export function githubEventLabel(event: RoutineGithubEvent, t: Translate = translate): string {
  switch (event) {
    case 'pull_request.opened':
      return t('auto.components.settings.cloudRoutines.event.prOpened', 'PR opened')
    case 'pull_request.labeled':
      return t('auto.components.settings.cloudRoutines.event.prLabeled', 'PR labeled')
    case 'pull_request.synchronize':
      return t('auto.components.settings.cloudRoutines.event.prPushed', 'PR updated (new commits)')
    case 'issues.opened':
      return t('auto.components.settings.cloudRoutines.event.issueOpened', 'Issue opened')
    case 'issues.labeled':
      return t('auto.components.settings.cloudRoutines.event.issueLabeled', 'Issue labeled')
    case 'issue_comment.created':
      return t('auto.components.settings.cloudRoutines.event.comment', 'New comment')
  }
}

/** One-line summary for lists: "Weekdays at 9:00 AM (America/New_York)", "GitHub: PR labeled `orca`". */
export function describeRoutineTrigger(
  trigger: RoutineTrigger,
  t: Translate = translate,
  intlLocale?: string
): string {
  if (trigger.kind === 'schedule') {
    return t(
      'auto.components.settings.cloudRoutines.trigger.scheduleSummaryZone',
      '{{value0}} {{value1}}',
      {
        value0: formatUiAutomationSchedule(trigger.cron, t, intlLocale),
        value1: shortTimeZoneName(trigger.timezone, intlLocale)
      }
    )
  }
  if (trigger.kind === 'webhook') {
    return t('auto.components.settings.cloudRoutines.trigger.webhook', 'Webhook')
  }
  const events = trigger.events.map((event) => githubEventLabel(event, t)).join(', ')
  const labels = trigger.labels?.length ? ` “${trigger.labels.join('”, “')}”` : ''
  return t('auto.components.settings.cloudRoutines.trigger.githubSummary', 'GitHub: {{value0}}', {
    value0: `${events}${labels}`
  })
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Every zone the runtime knows, with the local zone and UTC guaranteed present. */
export function timeZoneOptions(local: string = localTimeZone()): string[] {
  let zones: string[] = []
  try {
    zones =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        'timeZone'
      ) ?? []
  } catch {
    zones = []
  }
  const all = new Set([local, 'UTC', ...zones])
  return [...all].sort((a, b) => (a === local ? -1 : b === local ? 1 : a.localeCompare(b)))
}

/** "9:42" — minutes and seconds left, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** How a key's scopes read at a glance: the two presets, else custom. */
export function scopeSummaryKind(scopes: readonly CloudApiScope[]): ScopePreset {
  const set = new Set(scopes)
  const isExactly = (all: readonly CloudApiScope[]): boolean =>
    set.size === all.length && all.every((scope) => set.has(scope))
  const reads = CLOUD_API_SCOPES.filter((scope) => CLOUD_API_READ_SCOPES.includes(scope))
  if (isExactly(reads)) {
    return 'read'
  }
  const memberFull = CLOUD_API_SCOPES.filter((scope) => !CLOUD_API_ADMIN_SCOPES.includes(scope))
  return isExactly(CLOUD_API_SCOPES) || isExactly(memberFull) ? 'full' : 'custom'
}

/** "EST", "GMT+1": the short name people read next to a time; the IANA id when Intl has none. */
export function shortTimeZoneName(
  timeZone: string,
  intlLocale?: string,
  at: number = Date.now()
): string {
  try {
    const part = new Intl.DateTimeFormat(intlLocale, { timeZone, timeZoneName: 'short' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')
    return part?.value ?? timeZone
  } catch {
    return timeZone
  }
}

/** "America/New_York" → "New York"; "UTC" stays "UTC". */
export function friendlyTimeZone(timeZone: string): string {
  const city = timeZone.split('/').pop() ?? timeZone
  return city.replaceAll('_', ' ')
}
