import { getTopVisibleLineageRoots, getVisibleLineagePlacement } from './worktree-lineage-placement'

export type OccurrenceSectionPath = {
  key: string
  parent?: OccurrenceSectionPath
}

export type WorktreeOccurrence<Row> = {
  key: string
  row: Row
  owningSectionKey?: string
  sectionKey: string
  placement: 'pinned' | 'natural'
  sectionPath: OccurrenceSectionPath
  parent?: WorktreeOccurrence<Row>
  depth: number
  childCount: number
  isLastChild: boolean
  showProjectName: boolean
}

export type WorktreeOccurrenceSection<Row> = {
  key: string
  items: readonly Row[]
  revealPath?: OccurrenceSectionPath
  placement?: 'pinned' | 'natural'
}

export type WorktreeOccurrencePlan<Row> = {
  bySection: ReadonlyMap<string, readonly WorktreeOccurrence<Row>[]>
  preferredByIdentity: ReadonlyMap<string, WorktreeOccurrence<Row>>
}

type LineagePlacementRows<Row> = {
  pinned: Row[]
  natural: readonly Row[]
  displayRootByIdentity: ReadonlyMap<string, Row>
}

export function getLineagePlacementRows<Row>(args: {
  rows: readonly Row[]
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>
  identityOf: (row: Row) => string
  isPinned: (row: Row) => boolean
  duplicatePinned: boolean
}): LineagePlacementRows<Row> {
  const { rows, childrenByParentIdentity, identityOf } = args
  const pinnedPlacement = getVisibleLineagePlacement(
    rows,
    rows.filter(args.isPinned),
    childrenByParentIdentity,
    identityOf,
    true
  )
  const pinned = rows.filter((row) => pinnedPlacement.has(identityOf(row)))
  const natural = args.duplicatePinned
    ? rows
    : rows.filter((row) => !pinnedPlacement.has(identityOf(row)))
  return {
    pinned,
    natural,
    displayRootByIdentity: getTopVisibleLineageRoots(natural, childrenByParentIdentity, identityOf)
  }
}

/** Compute placement/disclosure before collapse removes occurrences. */
export function buildWorktreeOccurrencePlan<
  Row,
  Section extends WorktreeOccurrenceSection<Row>
>(args: {
  rows: readonly Row[]
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>
  identityOf: (row: Row) => string
  isPinned: (row: Row) => boolean
  duplicatePinned: boolean
  sectionsOf: (placement: LineagePlacementRows<Row>) => readonly Section[]
  owningSectionOf?: (row: Row) => { key: string; label: string }
  projectIdOf?: (row: Row) => string
}): WorktreeOccurrencePlan<Row> & { sections: readonly Section[] } {
  const { identityOf, childrenByParentIdentity } = args
  const ownerByIdentity = new Map(
    args.rows.map((row) => [identityOf(row), args.owningSectionOf?.(row)])
  )
  const sections = args.sectionsOf(getLineagePlacementRows(args))
  const parentByIdentity = new Map<string, string>()
  for (const [parent, children] of childrenByParentIdentity) {
    for (const child of children) {
      parentByIdentity.set(identityOf(child), parent)
    }
  }
  const bySection = new Map<string, WorktreeOccurrence<Row>[]>()
  const preferredByIdentity = new Map<string, WorktreeOccurrence<Row>>()
  for (const section of sections) {
    const sectionPath = section.revealPath ?? { key: section.key }
    const members = new Set(section.items.map(identityOf))
    const children = new Map<string, Row[]>()
    const roots: Row[] = []
    for (const row of section.items) {
      const parent = parentByIdentity.get(identityOf(row))
      if (parent !== undefined && members.has(parent)) {
        const siblings = children.get(parent) ?? []
        siblings.push(row)
        children.set(parent, siblings)
      } else {
        roots.push(row)
      }
    }
    const occurrences: WorktreeOccurrence<Row>[] = []
    const emitted = new Set<string>()
    const pending: { row: Row; parent?: WorktreeOccurrence<Row>; isLastChild: boolean }[] = []
    const emit = (): void => {
      while (pending.length > 0) {
        const next = pending.pop()
        if (!next) {
          continue
        }
        const identity = identityOf(next.row)
        if (emitted.has(identity)) {
          continue
        }
        emitted.add(identity)
        const descendants = children.get(identity) ?? []
        const owner = ownerByIdentity.get(identity)
        const occurrence: WorktreeOccurrence<Row> = {
          key: `${section.key}:${identity}`,
          row: next.row,
          owningSectionKey: owner?.key,
          sectionKey: section.key,
          placement: section.placement ?? 'natural',
          sectionPath,
          parent: next.parent,
          depth: next.parent ? next.parent.depth + 1 : 0,
          childCount: descendants.length,
          isLastChild: next.isLastChild,
          showProjectName:
            next.parent !== undefined &&
            args.projectIdOf !== undefined &&
            args.projectIdOf(next.row) !== args.projectIdOf(next.parent.row)
        }
        occurrences.push(occurrence)
        if (section.placement !== 'pinned' || !preferredByIdentity.has(identity)) {
          preferredByIdentity.set(identity, occurrence)
        }
        for (let i = descendants.length - 1; i >= 0; i -= 1) {
          pending.push({
            row: descendants[i],
            parent: occurrence,
            isLastChild: i === descendants.length - 1
          })
        }
      }
    }
    roots.forEach((row, i) => {
      pending.push({ row, isLastChild: i === roots.length - 1 })
      emit()
    })
    // Why: malformed older-peer cycles must not erase the entire list.
    for (const row of section.items) {
      if (!emitted.has(identityOf(row))) {
        pending.push({ row, isLastChild: true })
        emit()
      }
    }
    bySection.set(section.key, occurrences)
  }
  return { sections, bySection, preferredByIdentity }
}

/** Collapse only removes occurrences; it never changes their parent or section. */
export function getExpandedWorktreeOccurrences<Row>(
  occurrences: readonly WorktreeOccurrence<Row>[],
  isCollapsed: (row: Row) => boolean
): WorktreeOccurrence<Row>[] {
  const result: WorktreeOccurrence<Row>[] = []
  let hiddenBelowDepth = Infinity
  for (const occurrence of occurrences) {
    if (occurrence.depth > hiddenBelowDepth) {
      continue
    }
    hiddenBelowDepth = Infinity
    result.push(occurrence)
    if (isCollapsed(occurrence.row)) {
      hiddenBelowDepth = occurrence.depth
    }
  }
  return result
}
