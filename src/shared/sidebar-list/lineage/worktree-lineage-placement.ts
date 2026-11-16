export function getVisibleLineagePlacement<Row>(
  visibleRows: readonly Row[],
  roots: readonly Row[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>,
  identityOf: (row: Row) => string,
  bridgeHidden = false
): Map<string, Row> {
  const visible = new Set(visibleRows.map(identityOf))
  const placement = new Map<string, Row>()
  const seen = new Set<string>()
  for (const root of roots) {
    const pending = [root]
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
        for (const child of childrenByParentIdentity.get(identity) ?? []) {
          pending.push(child)
        }
      }
    }
  }
  return placement
}

/** A hidden parent breaks placement; a visible child starts its own section. */
export function getTopVisibleLineageRoots<Row>(
  visibleRows: readonly Row[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Row[]>,
  identityOf: (row: Row) => string
): Map<string, Row> {
  const childrenOfVisibleParents = new Set<string>()
  for (const row of visibleRows) {
    for (const child of childrenByParentIdentity.get(identityOf(row)) ?? []) {
      childrenOfVisibleParents.add(identityOf(child))
    }
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
