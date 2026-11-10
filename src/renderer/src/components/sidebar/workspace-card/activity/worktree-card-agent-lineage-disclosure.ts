/** Parents above a pane, so a collapsed ancestor can stand in for a hidden focused row. */
export function lineageAncestorPaneKeys<T extends { paneKey: string }>(
  childrenByParentPaneKey: ReadonlyMap<string, readonly T[]>,
  paneKey: string | null
): ReadonlySet<string> {
  const parentByChild = new Map<string, string>()
  for (const [parentPaneKey, children] of childrenByParentPaneKey) {
    for (const child of children) {
      parentByChild.set(child.paneKey, parentPaneKey)
    }
  }
  const ancestors = new Set<string>()
  for (let parent = paneKey ? parentByChild.get(paneKey) : undefined; parent;) {
    if (ancestors.has(parent)) {
      break
    }
    ancestors.add(parent)
    parent = parentByChild.get(parent)
  }
  return ancestors
}
