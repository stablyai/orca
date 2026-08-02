/**
 * Remove descendant placeholders already covered by an ancestor. Sorting puts
 * ancestors first; prefix lookups avoid quadratic scans across sibling paths.
 */
export function collapseQuickOpenExpansionPaths(
  expansionPaths: ReadonlyMap<string, boolean>
): [string, boolean][] {
  const sortedPaths = Array.from(expansionPaths).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  const collapsedPaths = new Map<string, boolean>()

  for (const [relPath, includeSymlinks] of sortedPaths) {
    let ancestorPath: string | undefined
    let slashIndex = relPath.indexOf('/')
    while (slashIndex !== -1) {
      const candidate = relPath.substring(0, slashIndex)
      if (collapsedPaths.has(candidate)) {
        ancestorPath = candidate
        break
      }
      slashIndex = relPath.indexOf('/', slashIndex + 1)
    }

    if (ancestorPath) {
      // Why: primary and ignored passes can overlap; the ancestor walk covers
      // the descendant, but must preserve either pass's symlink-leaf contract.
      if (includeSymlinks) {
        collapsedPaths.set(ancestorPath, true)
      }
      continue
    }
    collapsedPaths.set(relPath, includeSymlinks)
  }

  return Array.from(collapsedPaths)
}
