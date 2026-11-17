// What Archive does, in one voice for every surface: the Archive tooltip, the archive dialog and
// toast, and an archived workspace's countdown. Retention is always relative ("for 30 days",
// "deletes in 12 days"); only the card's managed facts show the exact deletion date.
import type { Translate } from '@/i18n/use-translate'

const DAY_MS = 86_400_000
/** The control plane's default ARCHIVE_TTL_DAYS, used until GET /v1/config answers. */
export const DEFAULT_ARCHIVE_TTL_DAYS = 30

/**
 * Facts (sandbox-control): archive runs Sleep first, so nothing is left running. Reconcile deletes
 * the archive at archive time + ARCHIVE_TTL_DAYS. `ttlDays` is that TTL, or null before it loads.
 */
export function archiveSnapshotDefinition(
  t: Translate,
  { ttlDays }: { ttlDays?: number | null }
): string {
  return t(
    'orcaCloudWorkspace.archiveSnapshot.definition',
    'Stops the workspace and keeps it for {{count}} days, then deletes it.',
    {
      count: ttlDays ?? DEFAULT_ARCHIVE_TTL_DAYS,
      defaultValue_one: 'Stops the workspace and keeps it for {{count}} day, then deletes it.'
    }
  )
}

/** The archive dialog's retention sentence, after "{{owner}}'s agents will stop." */
export function archiveDialogKeptLine(t: Translate, ttlDays?: number | null): string {
  return t(
    'orcaCloudWorkspace.archiveSnapshot.dialogKept',
    'It’s kept for {{count}} days, then deleted. You can unarchive it until then.',
    {
      count: ttlDays ?? DEFAULT_ARCHIVE_TTL_DAYS,
      defaultValue_one:
        'It’s kept for {{count}} day, then deleted. You can unarchive it until then.'
    }
  )
}

/** Whole days until `keptUntil`, rounded up so "deletes in 1 day" never shows for a past date. */
function daysUntilDeletion(keptUntil: number, now: number): number {
  return Math.max(0, Math.ceil((keptUntil - now) / DAY_MS))
}

/**
 * An archived workspace's detail line (card, hovercard): read-only, and how long until it's deleted.
 * Without a kept-until date (older control plane) it names the rule instead of inventing a date.
 */
export function archivedSnapshotLine(
  t: Translate,
  keptUntil?: number | null,
  now: number = Date.now()
): string {
  if (!keptUntil) {
    return t(
      'orcaCloudWorkspace.archiveSnapshot.archived',
      'Read-only. Deletes 30 days after archiving unless you unarchive it.'
    )
  }
  const days = daysUntilDeletion(keptUntil, now)
  return days === 0
    ? t(
        'orcaCloudWorkspace.archiveSnapshot.deletesToday',
        'Read-only. Deletes today unless you unarchive it.'
      )
    : t(
        'orcaCloudWorkspace.archiveSnapshot.deletesIn',
        'Read-only. Deletes in {{count}} days unless you unarchive it.',
        {
          count: days,
          defaultValue_one: 'Read-only. Deletes in {{count}} day unless you unarchive it.'
        }
      )
}

/**
 * An asleep workspace's countdown to idle deletion (the control plane deletes one left asleep and
 * unused for 90 days, and reports `idleDeleteAt` in its last 7), after "Asleep · ". Waking keeps it.
 */
export function asleepCountdownShort(t: Translate, deleteAt: number, now: number): string {
  const days = daysUntilDeletion(deleteAt, now)
  return days === 0
    ? t('orcaCloudWorkspace.asleep.deletesTodayShort', 'deletes today')
    : t('orcaCloudWorkspace.asleep.deletesInShort', 'deletes in {{count}} days', {
        count: days,
        defaultValue_one: 'deletes in {{count}} day'
      })
}

/** The archived view's header countdown, after "Archived 3 days ago · ". */
export function archivedCountdownShort(t: Translate, keptUntil: number, now: number): string {
  const days = daysUntilDeletion(keptUntil, now)
  return days === 0
    ? t('orcaCloudWorkspace.archived.deletesTodayShort', 'deletes today')
    : t('orcaCloudWorkspace.archived.deletesInShort', 'deletes in {{count}} days', {
        count: days,
        defaultValue_one: 'deletes in {{count}} day'
      })
}
