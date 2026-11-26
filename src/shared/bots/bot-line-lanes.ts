// A bot line's child workspaces at one level under it, so a deep run reads as one list of lanes.

/** Every descendant of `root`, each once, in tree order; a lineage loop stops at a repeat. */
export function botLineLanes<T>(
  root: T,
  childrenOf: (line: T) => readonly T[],
  identityOf: (line: T) => string
): T[] {
  const seen = new Set([identityOf(root)])
  const lanes: T[] = []
  const visit = (line: T): void => {
    for (const child of childrenOf(line)) {
      const identity = identityOf(child)
      if (!seen.has(identity)) {
        seen.add(identity)
        lanes.push(child)
        visit(child)
      }
    }
  }
  visit(root)
  return lanes
}

/** The lanes with those waiting on the owner first, otherwise in the given order. */
export function lanesNeedingYouFirst<T>(lanes: readonly T[], needsYou: (line: T) => boolean): T[] {
  return [...lanes].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)))
}
