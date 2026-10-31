import {
  classifyFetchRefspec,
  parseFetchMapping,
  matchRefPattern,
  compatibleFetchMapping,
  fetchMappingDomainsOverlap,
  resolveFetchTrackingRef
} from './git-fetch-refspec'
import { indexFetchMappings } from './git-fetch-coverage'
import {
  indexGitRefs,
  createSourceCoverageIndex,
  type GitFetchEffectRow,
  type GitRefFact
} from './git-fetch-ref-index'

/** Group equal domains before querying them: repeated aliases must not multiply proof work. */
export function createFetchEffectProof(
  rows: readonly GitFetchEffectRow[],
  refs: readonly GitRefFact[],
  sameRepository: (a: string, b: string) => boolean
) {
  const groups = new Map<
    string,
    { name: string; spec: string; names: Set<string>; url: string; consistent: boolean }
  >()
  for (const row of rows) {
    const parsed = parseFetchMapping(row.spec)
    const fact = parsed ? `+${parsed.source}:${parsed.destination}` : row.spec
    let group = groups.get(fact)
    if (!group) {
      group = {
        name: row.name,
        spec: row.spec,
        names: new Set(),
        url: row.url,
        consistent: Boolean(row.url)
      }
      groups.set(fact, group)
    }
    group.names.add(row.name)
    group.consistent = group.consistent && Boolean(row.url) && sameRepository(group.url, row.url)
  }
  const overlap = indexFetchMappings([...groups.values()])
  const refDomain = indexGitRefs(refs)
  const memo = new Map<string, boolean>()
  const distinct = (specs: readonly string[]) => [...new Set(specs)]
  const safe = (url: string, spec: string, claim = false): boolean => {
    const key = JSON.stringify([url, spec, claim])
    const prior = memo.get(key)
    if (prior !== undefined) {
      return prior
    }
    const map = parseFetchMapping(spec)
    const compatible = (other: { spec: string; url: string; consistent: boolean }) =>
      other.consistent && sameRepository(url, other.url) && compatibleFetchMapping(spec, other.spec)
    const intersecting = overlap(
      spec,
      (other) => fetchMappingDomainsOverlap(spec, other.spec) && !compatible(other)
    ).filter((other) => fetchMappingDomainsOverlap(spec, other.spec))
    const result = Boolean(
      map &&
      (!/^refs\/(heads|tags)\//.test(map.destination) ||
        (map.source.startsWith('refs/tags/') && map.source === map.destination)) &&
      intersecting.every(compatible) &&
      refDomain(map.destination).every(
        (row) =>
          !row.symref &&
          matchRefPattern(map.destination, row.ref) !== null &&
          (!claim ||
            intersecting.some((other) => {
              const existing = parseFetchMapping(other.spec)
              return (
                existing &&
                matchRefPattern(existing.destination, row.ref) !== null &&
                compatible(other)
              )
            }))
      )
    )
    memo.set(key, result)
    return result
  }
  return {
    safe,
    refDomain,
    exclusive: (name: string, namespace: string): boolean => {
      const probe = `+refs/heads/*:${namespace}*`
      const foreign = (other: { spec: string; names: ReadonlySet<string> }) =>
        (!(other.names.size === 1 && other.names.has(name)) &&
          fetchMappingDomainsOverlap(probe, other.spec)) ||
        !parseFetchMapping(other.spec)
      return !overlap(
        probe,
        foreign,
        (other) => other.names.size === 1 && other.names.has(name)
      ).some(foreign)
    },
    unambiguous: (name: string, source: string, destination: string) => {
      const accepts = (other: { spec: string; names: ReadonlySet<string> }) => {
        const map = parseFetchMapping(other.spec)
        return (
          !map ||
          matchRefPattern(map.destination, destination) === null ||
          (other.names.size === 1 && other.names.has(name))
        )
      }
      return overlap(`+${source}:${destination}`, (other) => !accepts(other)).every(accepts)
    },
    operation: (
      url: string,
      specs: readonly string[],
      source: string,
      kind: 'fetch' | 'push' | 'pull',
      followTags = false
    ): boolean => {
      specs = distinct(specs)
      const parsed = specs.map((spec) => ({ spec, row: classifyFetchRefspec(spec) }))
      if (parsed.some(({ row }) => row.kind === 'invalid')) {
        return false
      }
      const destinations: string[] = []
      if (kind === 'fetch') {
        const destination = resolveFetchTrackingRef(specs, source)
        if (!destination) {
          return false
        }
        destinations.push(destination)
      } else {
        const excluded =
          kind === 'pull' &&
          parsed.some(
            ({ row }) => row.kind === 'negative' && matchRefPattern(row.source, source) !== null
          )
        if (!excluded) {
          for (const { row } of parsed) {
            if (row.kind !== 'mapped' && row.kind !== 'empty') {
              continue
            }
            const capture = matchRefPattern(row.source, source)
            if (capture === null) {
              continue
            }
            if (row.kind === 'mapped') {
              destinations.push(
                kind === 'push'
                  ? row.trackingDestination.replace('*', capture)
                  : row.destination.replace('*', capture)
              )
            }
            if (kind === 'push') {
              break
            }
          }
        }
      }
      if (!destinations.every((destination) => safe(url, `+${source}:${destination}`))) {
        return false
      }
      if (!followTags) {
        return true
      }
      if (kind === 'pull' && !safe(url, '+refs/tags/*:refs/tags/*')) {
        return false
      }
      const prior = createSourceCoverageIndex()
      for (const { spec, row } of parsed) {
        if (row.kind !== 'mapped' && row.kind !== 'empty') {
          continue
        }
        let tagged: string | undefined
        if (row.kind === 'mapped') {
          const [prefix, suffix = ''] = row.source.split('*')
          if (prefix.startsWith('refs/tags/')) {
            tagged = spec
          } else if (row.source.includes('*') && 'refs/tags/'.startsWith(prefix)) {
            const capture = 'refs/tags/'.slice(prefix.length)
            tagged = `+refs/tags/*${suffix}:${row.destination.replace('*', `${capture}*`)}`
          }
        }
        const taggedSource = tagged && parseFetchMapping(tagged)!.source
        const shadowed = taggedSource && kind === 'push' && prior.covers(taggedSource)
        prior.add(row.source)
        if (tagged && !shadowed && !safe(url, tagged)) {
          return false
        }
      }
      return true
    }
  }
}
