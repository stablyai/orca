// Display helpers for team cloud workspaces (pure, unit-tested).
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat, uiNumberFormat } from '@/i18n/ui-intl-formatters'
import type { Translate } from '@/i18n/use-translate'
import type { CloudWorkspacePresence } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

// Intl formatter caches key on option identity, so this must be a module constant.
const DATE_FORMAT: Intl.DateTimeFormatOptions = {}
const USD_CENTS: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}
const USD_WHOLE: Intl.NumberFormatOptions = {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
}

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

/** Cost under a cent reads as "<$0.01", otherwise two decimals (never "$0.00" for a running VM). */
export function formatUsdMicros(micros: number, intlLocale?: string): string {
  if (micros <= 0) {
    return uiNumberFormat(USD_WHOLE, intlLocale).format(0)
  }
  if (micros < 10_000) {
    return `<${uiNumberFormat(USD_CENTS, intlLocale).format(0.01)}`
  }
  const dollars = micros / 1_000_000
  return dollars >= 100
    ? uiNumberFormat(USD_WHOLE, intlLocale).format(Math.round(dollars))
    : uiNumberFormat(USD_CENTS, intlLocale).format(dollars)
}

export function formatComputeHours(ms: number, t: Translate = translate): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return t('auto.components.cloudWorkspaces.computeMinutes', '{{value0}} min', {
      value0: minutes
    })
  }
  const hours = ms / 3_600_000
  return t('auto.components.cloudWorkspaces.computeHours', '{{value0}} h', {
    value0: hours >= 10 ? Math.round(hours) : hours.toFixed(1)
  })
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
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return t('auto.components.cloudWorkspaces.minutesAgo', '{{value0}}m ago', { value0: minutes })
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return t('auto.components.cloudWorkspaces.hoursAgo', '{{value0}}h ago', { value0: hours })
  }
  const days = Math.round(hours / 24)
  return days < 30
    ? t('auto.components.cloudWorkspaces.daysAgo', '{{value0}}d ago', { value0: days })
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

/** One entry per member (typing wins over viewing), with yourself last. */
export function presentMembers(
  presence: CloudWorkspacePresence[],
  selfId: string | null
): CloudWorkspacePresence[] {
  const byMember = new Map<string, CloudWorkspacePresence>()
  for (const p of presence) {
    const seen = byMember.get(p.userId)
    if (!seen || (p.state === 'typing' && seen.state !== 'typing')) {
      byMember.set(p.userId, p)
    }
  }
  return [...byMember.values()].sort(
    (a, b) => (a.userId === selfId ? 1 : 0) - (b.userId === selfId ? 1 : 0)
  )
}

export function presenceSummary(
  members: CloudWorkspacePresence[],
  directory: MemberDirectory,
  selfId: string | null,
  t: Translate = translate
): string {
  return members
    .map((p) => {
      const value0 = memberName(directory, p.userId, selfId, t)
      return p.state === 'typing'
        ? t('auto.components.cloudWorkspaces.memberTyping', '{{value0}} is typing', { value0 })
        : t('auto.components.cloudWorkspaces.memberViewing', '{{value0}} is viewing', { value0 })
    })
    .join(', ')
}
