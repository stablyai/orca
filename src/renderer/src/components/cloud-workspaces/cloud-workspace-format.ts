// Display helpers for team cloud workspaces (pure, unit-tested).
import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { uiDateTimeFormat, uiNumberFormat } from '@/i18n/ui-intl-formatters'
import type { Translate } from '@/i18n/use-translate'

// Intl formatter caches key on option identity, so this must be a module constant.
const DATE_FORMAT: Intl.DateTimeFormatOptions = {}
const HOURS: Intl.NumberFormatOptions = { maximumFractionDigits: 1 }
const HOURS_FINE: Intl.NumberFormatOptions = { maximumFractionDigits: 2 }

export type MemberDirectory = Map<string, { name: string; email: string | null }>

export function memberName(
  directory: MemberDirectory,
  userId: string,
  selfId: string | null,
  t: Translate = translate
): string {
  if (userId === selfId) {
    return t('auto.components.cloudWorkspaces.you', 'You')
  }
  return directory.get(userId)?.name ?? shortId(userId)
}

function shortId(userId: string): string {
  const tail = userId.split(':').at(-1) ?? userId
  return tail.length > 14 ? `${tail.slice(0, 12)}…` : tail
}

export function initials(name: string): string {
  const words = name
    .replace(/[@.].*$/, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** Sandbox hours as shown (one decimal, two under an hour), also the plural count for the copy. */
export function sandboxHours(ms: number): number {
  const hours = ms / 3_600_000
  const digits = hours < 1 ? 100 : 10
  return Math.round(hours * digits) / digits
}

/** "14.6", in the UI locale, for "{{hours}} sandbox hours". */
export function formatSandboxHours(ms: number, intlLocale?: string): string {
  const hours = sandboxHours(ms)
  return uiNumberFormat(hours < 1 ? HOURS_FINE : HOURS, intlLocale).format(hours)
}

export function formatRelative(
  at: number,
  now: number,
  t: Translate = translate,
  intlLocale?: string
): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) {
    return t('auto.components.cloudWorkspaces.justNow', 'just now')
  }
  // Intl, not hand-rolled "{{n}}m ago": word order, unit and plural follow the UI language.
  const locale = intlLocale ?? getIntlLocale()
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return formatUiNarrowRelativeTime(-minutes, 'minute', locale)
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return formatUiNarrowRelativeTime(-hours, 'hour', locale)
  }
  const days = Math.round(hours / 24)
  return days < 30
    ? formatUiNarrowRelativeTime(-days, 'day', locale)
    : uiDateTimeFormat(DATE_FORMAT, intlLocale).format(at)
}

export function repoLabel(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts
      .slice(-2)
      .join('/')
      .replace(/\.git$/, '')
  } catch {
    return url
  }
}

/** Stable hue per member so a teammate's avatar keeps its color everywhere. */
export function memberHue(userId: string): number {
  let hash = 0
  for (const char of userId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash % 360
}
