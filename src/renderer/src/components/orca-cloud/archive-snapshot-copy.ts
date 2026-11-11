// The one definition of an Orca Cloud archive "snapshot" (glossary: archive, Unarchive, snapshot,
// sandbox hours), as a plain string for state lines; ArchiveSnapshotTooltip shows it on Archive controls.
import type { Translate } from '@/i18n/use-translate'
import { formatShortDate } from '@/lib/orca-cloud/orca-cloud-workspace-state'

const DAY_MS = 86_400_000

/**
 * Facts (sandbox-control): archive runs Sleep first and metering counts running time only, so an
 * archived workspace uses no sandbox hours, like a sleeping one; storage isn't billed. Reconcile
 * deletes the snapshot at its kept-until date (archive time + ARCHIVE_TTL_DAYS, default 30).
 *
 * `keptUntil` is an archived workspace's own date; otherwise the date is today + the control plane's
 * TTL. With neither (offline, older control plane) the copy says "for 30 days" and names no date.
 */
export function archiveSnapshotDefinition(
  t: Translate,
  {
    keptUntil,
    ttlDays,
    now = Date.now()
  }: { keptUntil?: number | null; ttlDays?: number | null; now?: number }
): string {
  const until = keptUntil ?? (ttlDays ? now + ttlDays * DAY_MS : null)
  return until !== null
    ? t(
        'orcaCloudWorkspace.archiveSnapshot.definitionUntil',
        'Archive keeps a snapshot of this workspace (its files, chats and terminal history) until {{date}}, then deletes it. Unarchive it from its menu before then. Like a sleeping workspace, it doesn’t use sandbox hours.',
        { date: formatShortDate(until) }
      )
    : t(
        'orcaCloudWorkspace.archiveSnapshot.definition',
        'Archive keeps a snapshot of this workspace (its files, chats and terminal history) for 30 days, then deletes it. Unarchive it from its menu before then. Like a sleeping workspace, it doesn’t use sandbox hours.'
      )
}

/**
 * The same definition in the archived voice, for a workspace that is already archived (its archived
 * view and its state line everywhere): what the snapshot holds and the date it is deleted. Without a
 * kept-until date (older control plane) it names the 30-day rule instead of inventing a date.
 */
export function archivedSnapshotLine(t: Translate, keptUntil?: number | null): string {
  return keptUntil
    ? t(
        'orcaCloudWorkspace.archiveSnapshot.archivedUntil',
        'A read-only snapshot of its files, chats and terminal history. Unarchive before {{date}} to open terminals and agents again; after that it’s deleted.',
        { date: formatShortDate(keptUntil) }
      )
    : t(
        'orcaCloudWorkspace.archiveSnapshot.archived',
        'A read-only snapshot of its files, chats and terminal history. Unarchive within 30 days of archiving to open terminals and agents again; after that it’s deleted.'
      )
}
