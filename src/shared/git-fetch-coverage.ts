import { classifyFetchRefspec, parseFetchMapping } from './git-fetch-refspec'
import { isSafeGitRefName } from './git-status-upstream-ref'

/** Canonical creator coverage is proof only; semantic no-ops retain raw multivars. */
export function stockFetchCoverage(name: string, specs: readonly string[]) {
  const exact = new Set<string>()
  const rawPrefixes = new Set<string>()
  const base = `refs/remotes/${name}/`
  for (const spec of new Set(specs)) {
    const map = parseFetchMapping(spec)
    if (!spec.startsWith('+') || !map?.source.startsWith('refs/heads/')) {
      return undefined
    }
    const tail = map.source.slice(11)
    const star = tail.indexOf('*')
    if (
      map.destination !== base + tail ||
      (star !== -1 && star !== tail.length - 1) ||
      !isSafeGitRefName(map.source.replace('*', 'head')) ||
      !isSafeGitRefName(map.destination.replace('*', 'head'))
    ) {
      return undefined
    }
    if (star === -1) {
      exact.add(tail)
    } else {
      rawPrefixes.add(tail.slice(0, -1))
    }
  }
  const prefixes: string[] = []
  for (const prefix of [...rawPrefixes].sort()) {
    if (!prefixes.length || !prefix.startsWith(prefixes.at(-1)!)) {
      prefixes.push(prefix)
    }
  }
  const contains = (branch: string): boolean => {
    let lo = 0
    let hi = prefixes.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (prefixes[mid] <= branch) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo > 0 && branch.startsWith(prefixes[lo - 1])
  }
  for (const branch of exact) {
    if (contains(branch)) {
      exact.delete(branch)
    }
  }
  return {
    contains,
    covers: (branch: string) => exact.has(branch) || contains(branch),
    signature: JSON.stringify([prefixes, [...exact].sort()]),
    specs: [
      ...prefixes.map((tail) => `+refs/heads/${tail}*:${base}${tail}*`),
      ...[...exact].sort().map((tail) => `+refs/heads/${tail}:${base}${tail}`)
    ]
  }
}

/** Prefix index bounds candidate proofs to mappings with intersecting destination domains. */
export function indexFetchMappings<T extends { name: string; spec: string }>(
  rows: readonly T[]
): (spec: string, stop?: (row: T) => boolean, skip?: (row: T) => boolean) => readonly T[] {
  const patterns = new Map<string, T[]>()
  const exact = new Map<string, T[]>()
  const unknown: T[] = []
  for (const row of rows) {
    const parsed = classifyFetchRefspec(row.spec)
    if (parsed.kind !== 'mapped') {
      if (parsed.kind === 'invalid') {
        unknown.push(row)
      }
      continue
    }
    const wildcard = parsed.destination.includes('*')
    const key = parsed.destination.split('*')[0]
    const index = wildcard ? patterns : exact
    const bucket = index.get(key) ?? []
    bucket.push(row)
    index.set(key, bucket)
  }
  const keys = [...new Set([...patterns.keys(), ...exact.keys()])].sort()
  return (spec, stop, skip) => {
    const mapping = parseFetchMapping(spec)
    const prefix = mapping?.destination.split('*')[0]
    function* candidates() {
      if (!prefix) {
        yield* rows
        return
      }
      yield* unknown
      for (let end = 0; end <= prefix.length; end += 1) {
        yield* patterns.get(prefix.slice(0, end)) ?? []
      }
      if (!mapping!.destination.includes('*')) {
        yield* exact.get(prefix) ?? []
        return
      }
      yield* exact.get(prefix) ?? []
      let lo = 0
      let hi = keys.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (keys[mid] <= prefix) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      for (let i = lo; i < keys.length && keys[i].startsWith(prefix); i += 1) {
        yield* patterns.get(keys[i]) ?? []
        yield* exact.get(keys[i]) ?? []
      }
    }
    const found: T[] = []
    for (const row of candidates()) {
      if (skip?.(row)) {
        continue
      }
      found.push(row)
      if (stop?.(row)) {
        break
      }
    }
    return found
  }
}
