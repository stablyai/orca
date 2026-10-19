/** Keeps alternative character positions without recursively retrying path prefixes. */
export function matchQuickOpenSeparatorAlternatives(
  query: string,
  path: string,
  boundaries: ReadonlySet<number> | undefined
): number | null {
  if (!boundaries?.size && !/[-_ ]/.test(path)) {
    return null
  }
  let previous = new Float64Array(path.length + 1).fill(Infinity)
  let current = new Float64Array(path.length + 1)
  previous[0] = 0
  for (let qi = 0; qi < query.length; qi++) {
    current.fill(Infinity)
    const separator = query[qi] === '-' || query[qi] === '_'
    let best = Infinity
    for (let ti = 0; ti < path.length; ti++) {
      if (ti > 0) {
        best = Math.min(best, previous[ti] - ti)
      }
      const actual = path[ti]
      const matches = separator
        ? actual === '-' || actual === '_' || actual === ' '
        : actual === query[qi]
      if (matches) {
        const prefix = Math.min(previous[0], best + ti)
        const boundary = ti > 0 && '/.-_'.includes(path[ti - 1]) ? 5 : 0
        current[ti + 1] = Math.min(current[ti + 1], prefix - boundary)
      }
      if (separator && ti > 0 && boundaries?.has(ti)) {
        current[ti] = Math.min(current[ti], previous[ti] + 2)
      }
    }
    ;[previous, current] = [current, previous]
  }
  const score = previous.reduce((best, value) => Math.min(best, value), Infinity)
  return Number.isFinite(score) ? score : null
}
