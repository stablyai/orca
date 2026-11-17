// How a member's cloud workspace list is arranged from their synced prefs (/v1/team/prefs): Pinned
// on top in pin order, then sections in their order, rows in their manual order. Pure and shared,
// so the desktop and the phone follow the same rules.
import type { CloudWorkspacePrefsDocument } from './cloud-workspaces-wire'

/** What arranging needs from a workspace (the desktop's and the phone's shapes both fit). */
type ArrangeableWorkspace = {
  id: string
  section?: string | null
  archivedAt?: number | null
}

const MAX_PINNED = 200

type CloudWorkspaceGroup<W extends ArrangeableWorkspace = ArrangeableWorkspace> = {
  /** Stable React key and drag scope: `pinned`, `section:<name>` or `none`. */
  key: string
  kind: 'pinned' | 'section' | 'none'
  section: string | null
  rows: W[]
  collapsed: boolean
}

/** Rows ranked by an explicit id list first (in that order), then the rest in their incoming order. */
function rankBy<T extends { id: string }>(rows: readonly T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]))
  return rows
    .map((row, index) => ({ row, index, rank: rank.get(row.id) }))
    .sort((a, b) =>
      a.rank !== undefined && b.rank !== undefined
        ? a.rank - b.rank
        : a.rank !== undefined
          ? -1
          : b.rank !== undefined
            ? 1
            : a.index - b.index
    )
    .map((entry) => entry.row)
}

/** Archived workspaces never sit in Pinned (they keep their pin for when they come back). */
function isPinnedRow(w: ArrangeableWorkspace, doc: CloudWorkspacePrefsDocument): boolean {
  return (w.archivedAt ?? null) === null && doc.pinned.includes(w.id)
}

export function arrangeCloudWorkspaces<W extends ArrangeableWorkspace>(
  visible: readonly W[],
  doc: CloudWorkspacePrefsDocument
): CloudWorkspaceGroup<W>[] {
  const pinned = rankBy(
    visible.filter((w) => isPinnedRow(w, doc)),
    doc.pinned
  )
  const rest = rankBy(
    visible.filter((w) => !isPinnedRow(w, doc)),
    doc.order
  )
  const bySection = new Map<string, W[]>()
  for (const w of rest) {
    const key = w.section ?? ''
    bySection.set(key, [...(bySection.get(key) ?? []), w])
  }
  const sectionRank = new Map(doc.sections.map((name, index) => [name, index]))
  const sections = [...bySection.keys()].sort((a, b) => {
    if (a === '' || b === '') {
      return a === '' ? 1 : -1
    }
    const ra = sectionRank.get(a)
    const rb = sectionRank.get(b)
    if (ra !== undefined || rb !== undefined) {
      return ra === undefined ? 1 : rb === undefined ? -1 : ra - rb
    }
    return a.localeCompare(b)
  })
  const groups: CloudWorkspaceGroup<W>[] = []
  if (pinned.length > 0) {
    groups.push({ key: 'pinned', kind: 'pinned', section: null, rows: pinned, collapsed: false })
  }
  for (const section of sections) {
    groups.push({
      key: section ? `section:${section}` : 'none',
      kind: section ? 'section' : 'none',
      section: section || null,
      rows: bySection.get(section)!,
      collapsed: section !== '' && doc.collapsed.includes(section)
    })
  }
  return groups
}

export function setPinned(
  doc: CloudWorkspacePrefsDocument,
  id: string,
  pinned: boolean
): CloudWorkspacePrefsDocument {
  if (pinned === doc.pinned.includes(id)) {
    return doc
  }
  return pinned
    ? {
        ...doc,
        // A new pin goes to the bottom of Pinned, like dropping it there.
        pinned: [...doc.pinned, id].slice(-MAX_PINNED),
        order: doc.order.filter((other) => other !== id)
      }
    : { ...doc, pinned: doc.pinned.filter((other) => other !== id) }
}
