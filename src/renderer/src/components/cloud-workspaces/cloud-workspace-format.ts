// Display helpers for team cloud workspaces (pure, unit-tested).
import { getIntlLocale, translate } from '@/i18n/i18n'
import { uiDateTimeFormat, uiNumberFormat } from '@/i18n/ui-intl-formatters'
import type { Translate } from '@/i18n/use-translate'
import type { CloudWorkspacePresence } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

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

/** "Bob is typing, Eve is viewing" as a locale list, never hand-joined. */
export function presenceSummary(
  members: CloudWorkspacePresence[],
  directory: MemberDirectory,
  selfId: string | null,
  t: Translate = translate,
  intlLocale: string = getIntlLocale()
): string {
  const clauses = members.map((p) => {
    // "You" takes its own verb form; it is never slotted into "{{name}} is …".
    if (p.userId === selfId) {
      return p.state === 'typing'
        ? t('auto.components.cloudWorkspaces.youAreTyping', 'You are typing')
        : t('auto.components.cloudWorkspaces.youAreViewing', 'You are viewing')
    }
    const value0 = memberName(directory, p.userId, selfId, t)
    return p.state === 'typing'
      ? t('auto.components.cloudWorkspaces.memberTyping', '{{value0}} is typing', { value0 })
      : t('auto.components.cloudWorkspaces.memberViewing', '{{value0}} is viewing', { value0 })
  })
  return formatNameList(clauses, intlLocale)
}

/** "Grace, Linus and Mae" in the UI locale, never hand-joined. */
export function formatNameList(names: string[], intlLocale: string = getIntlLocale()): string {
  return new Intl.ListFormat(intlLocale, { style: 'long', type: 'conjunction' }).format(names)
}
