import {
  getVisibleLineageAncestorRoots,
  getVisibleLineagePlacement
} from './worktree-lineage-placement'

const EMPTY_OCCURRENCES: readonly never[] = []

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
  let pinnedRoots: Row[] | undefined
  for (const row of rows) {
    if (args.isPinned(row)) {
      pinnedRoots ??= []
      pinnedRoots.push(row)
    }
  }
  if (!pinnedRoots) {
    return {
      pinned: [],
      natural: rows,
      displayRootByIdentity: getVisibleLineageAncestorRoots(
        rows,
        childrenByParentIdentity,
        identityOf
      )
    }
  }
  const pinnedPlacement = getVisibleLineagePlacement(
    rows,
    pinnedRoots,
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
    displayRootByIdentity: getVisibleLineageAncestorRoots(
      natural,
      childrenByParentIdentity,
      identityOf
    )
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
  owningSectionKeyOf?: (row: Row) => string
  projectIdOf?: (row: Row) => string
}): WorktreeOccurrencePlan<Row> & { sections: readonly Section[] } {
  const { identityOf, childrenByParentIdentity, owningSectionOf } = args
  const owningSectionKeyOf =
    args.owningSectionKeyOf ??
    (owningSectionOf ? (row: Row): string => owningSectionOf(row).key : undefined)
  const sections = args.sectionsOf(getLineagePlacementRows(args))
  const hasLineage = childrenByParentIdentity.size > 0
  let parentByIdentity: Map<string, string> | undefined
  if (hasLineage) {
    parentByIdentity = new Map<string, string>()
    for (const [parent, children] of childrenByParentIdentity) {
      for (const child of children) {
        parentByIdentity.set(identityOf(child), parent)
      }
    }
  }
  const bySection = new Map<string, readonly WorktreeOccurrence<Row>[]>()
  const preferredByIdentity = new Map<string, WorktreeOccurrence<Row>>()
  for (const section of sections) {
    const items = section.items
    if (items.length === 0) {
      bySection.set(section.key, EMPTY_OCCURRENCES)
      continue
    }
    const sectionPath = section.revealPath ?? { key: section.key }
    const placement = section.placement ?? 'natural'
    const isPinnedSection = section.placement === 'pinned'
    const makeFlatOccurrence = (
      row: Row,
      identity: string,
      isLastChild: boolean
    ): WorktreeOccurrence<Row> => {
      const occurrence: WorktreeOccurrence<Row> = {
        key: `${section.key}:${identity}`,
        row,
        owningSectionKey: owningSectionKeyOf?.(row),
        sectionKey: section.key,
        placement,
        sectionPath,
        parent: undefined,
        depth: 0,
        childCount: 0,
        isLastChild,
        showProjectName: false
      }
      if (!isPinnedSection || !preferredByIdentity.has(identity)) {
        preferredByIdentity.set(identity, occurrence)
      }
      return occurrence
    }
    let sectionHasLineageChild = false
    if (parentByIdentity) {
      for (const row of items) {
        if (parentByIdentity.has(identityOf(row))) {
          sectionHasLineageChild = true
          break
        }
      }
    }
    if (!parentByIdentity || !sectionHasLineageChild) {
      if (items.length === 1) {
        const row = items[0]
        bySection.set(section.key, [makeFlatOccurrence(row, identityOf(row), true)])
        continue
      }
      const occurrences: WorktreeOccurrence<Row>[] = []
      const emitted = new Set<string>()
      const lastIndex = items.length - 1
      for (let i = 0; i < items.length; i += 1) {
        const row = items[i]
        const identity = identityOf(row)
        if (emitted.has(identity)) {
          continue
        }
        emitted.add(identity)
        occurrences.push(makeFlatOccurrence(row, identity, i === lastIndex))
      }
      bySection.set(section.key, occurrences)
      continue
    }
    const occurrences: WorktreeOccurrence<Row>[] = []
    const emitted = new Set<string>()
    const members = new Set<string>()
    for (const row of section.items) {
      members.add(identityOf(row))
    }
    const children = new Map<string, Row[]>()
    const roots: Row[] = []
    for (const row of section.items) {
      const parent = parentByIdentity.get(identityOf(row))
      if (parent !== undefined && members.has(parent)) {
        const siblings = children.get(parent)
        if (siblings) {
          siblings.push(row)
        } else {
          children.set(parent, [row])
        }
      } else {
        roots.push(row)
      }
    }
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
        const descendants = children.get(identity)
        const occurrence: WorktreeOccurrence<Row> = {
          key: `${section.key}:${identity}`,
          row: next.row,
          owningSectionKey: owningSectionKeyOf?.(next.row),
          sectionKey: section.key,
          placement,
          sectionPath,
          parent: next.parent,
          depth: next.parent ? next.parent.depth + 1 : 0,
          childCount: descendants ? descendants.length : 0,
          isLastChild: next.isLastChild,
          showProjectName:
            next.parent !== undefined &&
            args.projectIdOf !== undefined &&
            args.projectIdOf(next.row) !== args.projectIdOf(next.parent.row)
        }
        occurrences.push(occurrence)
        if (!isPinnedSection || !preferredByIdentity.has(identity)) {
          preferredByIdentity.set(identity, occurrence)
        }
        if (descendants) {
          for (let i = descendants.length - 1; i >= 0; i -= 1) {
            pending.push({
              row: descendants[i],
              parent: occurrence,
              isLastChild: i === descendants.length - 1
            })
          }
        }
      }
    }
    const lastRootIndex = roots.length - 1
    for (let i = 0; i < roots.length; i += 1) {
      const row = roots[i]
      const identity = identityOf(row)
      if (emitted.has(identity)) {
        continue
      }
      const descendants = children.get(identity)
      if (!descendants || descendants.length === 0) {
        emitted.add(identity)
        occurrences.push(makeFlatOccurrence(row, identity, i === lastRootIndex))
        continue
      }
      pending.push({ row, isLastChild: i === lastRootIndex })
      emit()
    }
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
