export type LineagePlacementRows<Row> = {
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
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (args.isPinned(row)) {
      ;(pinnedRoots ??= []).push(row)
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
  const pinned: Row[] = []
  const natural: Row[] | null = args.duplicatePinned ? null : []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (pinnedPlacement.has(identityOf(row))) {
      pinned.push(row)
    } else if (natural) {
      natural.push(row)
    }
  }
  const naturalRows = natural ?? rows
  return {
    pinned,
    natural: naturalRows,
    displayRootByIdentity: getVisibleLineageAncestorRoots(
      naturalRows,
      childrenByParentIdentity,
      identityOf
    )
  }
}

export function getVisibleLineagePlacement<Row>(
  visibleRows: readonly Row[],
  roots: readonly Row[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>,
  identityOf: (row: Row) => string,
  bridgeHidden = false
): Map<string, Row> {
  const placement = new Map<string, Row>()
  if (roots.length === 0 || visibleRows.length === 0) {
    return placement
  }
  let anyRootHasChildren = false
  if (childrenByParentIdentity.size > 0) {
    for (let i = 0; i < roots.length; i += 1) {
      const rootChildren = childrenByParentIdentity.get(identityOf(roots[i]))
      if (rootChildren && rootChildren.length > 0) {
        anyRootHasChildren = true
        break
      }
    }
  }
  if (!anyRootHasChildren) {
    const wanted = new Map<string, Row>()
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i]
      const identity = identityOf(root)
      if (!wanted.has(identity)) {
        wanted.set(identity, root)
      }
    }
    for (let i = 0; i < visibleRows.length; i += 1) {
      const identity = identityOf(visibleRows[i])
      const root = wanted.get(identity)
      if (root !== undefined && !placement.has(identity)) {
        placement.set(identity, root)
        if (placement.size === wanted.size) {
          break
        }
      }
    }
    return placement
  }
  const visible = new Set<string>()
  for (let i = 0; i < visibleRows.length; i += 1) {
    visible.add(identityOf(visibleRows[i]))
  }
  const seen = new Set<string>()
  const pending: Row[] = []
  for (const root of roots) {
    const rootIdentity = identityOf(root)
    if (seen.has(rootIdentity)) {
      continue
    }
    const rootChildren = childrenByParentIdentity.get(rootIdentity)
    if (!rootChildren || rootChildren.length === 0) {
      seen.add(rootIdentity)
      if (visible.has(rootIdentity)) {
        placement.set(rootIdentity, root)
      }
      continue
    }
    pending.push(root)
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) {
        continue
      }
      const identity = identityOf(current)
      if (seen.has(identity)) {
        continue
      }
      seen.add(identity)
      const isVisible = visible.has(identity)
      if (isVisible) {
        placement.set(identity, root)
      }
      if (isVisible || bridgeHidden) {
        const children = childrenByParentIdentity.get(identity)
        if (children) {
          for (const child of children) {
            pending.push(child)
          }
        }
      }
    }
  }
  return placement
}

const EMPTY_DISPLAY_ROOTS: ReadonlyMap<string, never> = new Map<string, never>()

/**
 * Sparse map of visible descendants to their top visible lineage root.
 * Rows that are their own display root are omitted so callers fall back to the row itself.
 */
export function getVisibleLineageAncestorRoots<Row>(
  visibleRows: readonly Row[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>,
  identityOf: (row: Row) => string
): ReadonlyMap<string, Row> {
  if (childrenByParentIdentity.size === 0 || visibleRows.length === 0) {
    return EMPTY_DISPLAY_ROOTS
  }
  const childrenOfVisibleParents = new Set<string>()
  const visibleParents: Row[] = []
  for (let i = 0; i < visibleRows.length; i += 1) {
    const row = visibleRows[i]
    const children = childrenByParentIdentity.get(identityOf(row))
    if (children && children.length > 0) {
      visibleParents.push(row)
      for (let j = 0; j < children.length; j += 1) {
        childrenOfVisibleParents.add(identityOf(children[j]))
      }
    }
  }
  if (childrenOfVisibleParents.size === 0) {
    return EMPTY_DISPLAY_ROOTS
  }
  const visible = new Set<string>()
  for (let i = 0; i < visibleRows.length; i += 1) {
    visible.add(identityOf(visibleRows[i]))
  }
  const placement = new Map<string, Row>()
  const seen = new Set<string>()
  const pending: Row[] = []
  for (const root of visibleParents) {
    const rootIdentity = identityOf(root)
    if (childrenOfVisibleParents.has(rootIdentity) || seen.has(rootIdentity)) {
      continue
    }
    seen.add(rootIdentity)
    const rootChildren = childrenByParentIdentity.get(rootIdentity)
    if (!rootChildren) {
      continue
    }
    for (const child of rootChildren) {
      pending.push(child)
    }
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) {
        continue
      }
      const identity = identityOf(current)
      if (seen.has(identity) || !visible.has(identity)) {
        continue
      }
      seen.add(identity)
      placement.set(identity, root)
      const children = childrenByParentIdentity.get(identity)
      if (children) {
        for (const child of children) {
          pending.push(child)
        }
      }
    }
  }
  return placement.size === 0 ? EMPTY_DISPLAY_ROOTS : placement
}

/** A hidden parent breaks placement; a visible child starts its own section. */
export function getTopVisibleLineageRoots<Row>(
  visibleRows: readonly Row[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>,
  identityOf: (row: Row) => string
): Map<string, Row> {
  if (childrenByParentIdentity.size === 0) {
    const placement = new Map<string, Row>()
    for (const row of visibleRows) {
      const identity = identityOf(row)
      if (!placement.has(identity)) {
        placement.set(identity, row)
      }
    }
    return placement
  }
  const childrenOfVisibleParents = new Set<string>()
  for (const row of visibleRows) {
    const children = childrenByParentIdentity.get(identityOf(row))
    if (children) {
      for (const child of children) {
        childrenOfVisibleParents.add(identityOf(child))
      }
    }
  }
  if (childrenOfVisibleParents.size === 0) {
    const placement = new Map<string, Row>()
    for (const row of visibleRows) {
      const identity = identityOf(row)
      if (!placement.has(identity)) {
        placement.set(identity, row)
      }
    }
    return placement
  }
  const roots = visibleRows.filter((row) => !childrenOfVisibleParents.has(identityOf(row)))
  const placement = getVisibleLineagePlacement(
    visibleRows,
    roots,
    childrenByParentIdentity,
    identityOf
  )
  for (const row of visibleRows) {
    const identity = identityOf(row)
    if (!placement.has(identity)) {
      placement.set(identity, row)
    }
  }
  return placement
}
