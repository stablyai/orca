import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'

// Stands for "this note was not in the list"; a serialized note is never empty.
const ABSENT = ''

/**
 * Every version of each note this copy may have left on its host since its last confirmed save:
 * the list it last confirmed and every list it sent that failed (a failed write may have landed).
 */
export type KnownNoteVersions = { lists: number; byId: Map<string, Set<string>> }

export function createKnownNoteVersions(): KnownNoteVersions {
  return { lists: 0, byId: new Map() }
}

// Why sorted keys: the host may hand back a note with its fields in another order.
function versionOf(note: DiffComment | undefined): string {
  if (!note) {
    return ABSENT
  }
  const entries = Object.entries(note)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

/** Records one list the host may hold; a note missing from it may be absent on the host. */
export function addKnownList(known: KnownNoteVersions, list: readonly DiffComment[]): void {
  const ids = new Set(list.map((note) => note.id))
  for (const [id, versions] of known.byId) {
    if (!ids.has(id)) {
      versions.add(ABSENT)
    }
  }
  for (const note of list) {
    const versions = known.byId.get(note.id) ?? new Set(known.lists > 0 ? [ABSENT] : [])
    versions.add(versionOf(note))
    known.byId.set(note.id, versions)
  }
  known.lists += 1
}

function isKnown(known: KnownNoteVersions, id: string, note: DiffComment | undefined): boolean {
  const versions = known.byId.get(id)
  // A note this copy never listed was absent in every list it knows.
  return versions ? versions.has(versionOf(note)) : note === undefined
}

/**
 * The write after a failed one, decided note by note against what the host holds now.
 * This copy's edit of a note is "it now shows a version it never confirmed or sent"; a host version
 * this copy confirmed or sent is its own, and a host version outside those is another device's.
 * - Host holds a version of this copy's: this copy's view applies (edit, add or delete). A note
 *   whose save failed but landed is removed only while the host still holds that exact version.
 * - Another device changed, added or deleted it and this copy did not edit it: the change stays.
 * - Both changed it: the rule of a save without a failure, so this copy's edit or delete wins over
 *   another device's edit, and another device's delete wins over this copy's edit.
 * The whole intended list is sent, so an older host that replaces the list still ends with this
 * result. Its base is the host's list as read, so a host that merges keeps a change made after the
 * read. Past the size budget the base names only the notes this write changes: untouched notes are
 * then never sent twice, at the cost of a note another device deletes between the read and the
 * write coming back.
 */
export function recoveryWrite(
  held: readonly DiffComment[],
  requested: readonly DiffComment[],
  known: KnownNoteVersions
): { diffComments: DiffComment[]; diffCommentsBase: DiffComment[] } {
  const heldIds = new Set(held.map((note) => note.id))
  const requestedById = new Map(requested.map((note) => [note.id, note]))
  const intended = (id: string, onHost: DiffComment | undefined): DiffComment | undefined => {
    const shown = requestedById.get(id)
    if (isKnown(known, id, onHost)) {
      return shown
    }
    if (isKnown(known, id, shown)) {
      return onHost
    }
    return onHost ? shown : undefined
  }
  const diffComments = [
    ...held.flatMap((note) => intended(note.id, note) ?? []),
    ...requested.flatMap((note) =>
      heldIds.has(note.id) ? [] : (intended(note.id, undefined) ?? [])
    )
  ]
  if (byteLength(held) + byteLength(diffComments) <= RECOVERY_FULL_BASE_MAX_BYTES) {
    return { diffComments, diffCommentsBase: [...held] }
  }
  const intendedById = new Map(diffComments.map((note) => [note.id, note]))
  return {
    diffComments,
    diffCommentsBase: held.filter(
      (note) => versionOf(intendedById.get(note.id)) !== versionOf(note)
    )
  }
}

// Why half: a sealed paired request is capped at 1 MiB, and the update carries other fields too.
export const RECOVERY_FULL_BASE_MAX_BYTES = 512 * 1024

function byteLength(notes: readonly DiffComment[]): number {
  return new TextEncoder().encode(JSON.stringify(notes)).length
}
