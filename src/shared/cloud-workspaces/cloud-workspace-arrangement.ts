// How a member's cloud workspace list is arranged from their synced prefs (/v1/team/prefs): Pinned
// on top in pin order, then sections in their order, rows in their manual order. Pure and shared,
// so the desktop's Home and the phone follow the same rules.
import type { CloudWorkspacePrefsDocument } from './cloud-workspaces-wire'

/** What arranging needs from a workspace (the desktop's and the phone's shapes both fit). */
export type ArrangeableWorkspace = {
  id: string
  section?: string | null
  archivedAt?: number | null
}

export const MAX_PINNED = 200
const MAX_ORDER = 500

export type CloudWorkspaceGroup<W extends ArrangeableWorkspace = ArrangeableWorkspace> = {
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
export function isPinnedRow(w: ArrangeableWorkspace, doc: CloudWorkspacePrefsDocument): boolean {
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

/**
 * The group's rows now read `ids` top to bottom (after a drag or Move up/down). Pinned rewrites
 * pin order; a section moves those rows to the front of the manual order, keeping their sequence.
 * Ids outside the group (other sections, or rows a filter hides) keep their places.
 */
export function reorderGroup(
  doc: CloudWorkspacePrefsDocument,
  group: Pick<CloudWorkspaceGroup, 'kind'>,
  ids: readonly string[]
): CloudWorkspacePrefsDocument {
  const moved = new Set(ids)
  if (group.kind === 'pinned') {
    const hidden = doc.pinned.filter((id) => !moved.has(id))
    return { ...doc, pinned: [...ids, ...hidden].slice(0, MAX_PINNED) }
  }
  const others = doc.order.filter((id) => !moved.has(id))
  return {
    ...doc,
    order: [...ids.filter((id) => !doc.pinned.includes(id)), ...others].slice(0, MAX_ORDER)
  }
}

/** Moves `id` by `delta` places within the group's current rows (Move up / Move down). */
export function nudge(ids: readonly string[], id: string, delta: number): string[] | null {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= ids.length) {
    return null
  }
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** Moves `id` to sit where `overId` is (drag and drop within one group). */
export function dropOnto(ids: readonly string[], id: string, overId: string): string[] | null {
  if (id === overId || !ids.includes(id) || !ids.includes(overId)) {
    return null
  }
  return nudge(ids, id, ids.indexOf(overId) - ids.indexOf(id))
}

/** Section order after moving `section` by `delta` among the sections shown right now. */
export function moveSection(
  doc: CloudWorkspacePrefsDocument,
  shown: readonly string[],
  section: string,
  delta: number
): CloudWorkspacePrefsDocument | null {
  const next = nudge(shown, section, delta)
  if (!next) {
    return null
  }
  const rest = doc.sections.filter((name) => !next.includes(name))
  return { ...doc, sections: [...next, ...rest].slice(0, 50) }
}

export function setCollapsed(
  doc: CloudWorkspacePrefsDocument,
  section: string,
  collapsed: boolean
): CloudWorkspacePrefsDocument {
  if (collapsed === doc.collapsed.includes(section)) {
    return doc
  }
  return {
    ...doc,
    collapsed: collapsed
      ? [...doc.collapsed, section].slice(-50)
      : doc.collapsed.filter((name) => name !== section)
  }
}
