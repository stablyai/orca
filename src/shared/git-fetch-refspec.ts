import { isSafeGitRefName } from './git-status-upstream-ref'

export function matchRefPattern(pattern: string, ref: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) {
    return pattern === ref ? '' : null
  }
  if (star !== pattern.lastIndexOf('*')) {
    return null
  }
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  return ref.startsWith(prefix) &&
    ref.endsWith(suffix) &&
    ref.length >= prefix.length + suffix.length
    ? ref.slice(prefix.length, ref.length - suffix.length)
    : null
}

export function sourceRefsForTarget(
  refspecs: readonly string[],
  target: string,
  checkpoint?: () => void
): string[] {
  refspecs = [...new Set(refspecs)]
  if (target.includes('*')) {
    return []
  }
  const sources = new Set<string>()
  for (const refspec of refspecs) {
    checkpoint?.()
    const parsed = parseFetchMapping(refspec)
    if (!parsed) {
      continue
    }
    const { source, destination } = parsed
    const capture = matchRefPattern(destination, target)
    if (capture !== null) {
      const resolved = source.replace('*', capture)
      if (!resolved.includes('*')) {
        sources.add(resolved)
      }
    }
  }
  // Explicit refspecs bypass negative fetch mappings, so preserve their exclusions here.
  return [...sources].filter(
    (source) =>
      !refspecs.some((refspec) => {
        checkpoint?.()
        return refspec.startsWith('^') && matchRefPattern(refspec.slice(1), source) !== null
      })
  )
}

export function targetRefsForSource(refspecs: readonly string[], source: string): string[] {
  refspecs = [...new Set(refspecs)]
  if (
    refspecs.some((spec) => spec.startsWith('^') && matchRefPattern(spec.slice(1), source) !== null)
  ) {
    return []
  }
  return refspecs.flatMap((spec) => {
    const parsed = parseFetchMapping(spec)
    const capture = parsed ? matchRefPattern(parsed.source, source) : null
    return parsed && capture !== null ? [parsed.destination.replace('*', capture)] : []
  })
}

export type GitFetchSpec =
  | { kind: 'mapped'; source: string; destination: string; trackingDestination: string }
  | { kind: 'no-store' | 'empty' | 'negative'; source: string }
  | { kind: 'invalid' }

/** Fetch storage DWIM and ordered native tracking are different views of one raw rule. */
export function classifyFetchRefspec(spec: string): GitFetchSpec {
  const raw = spec.replace(/^\+/, '')
  const negative = raw.startsWith('^')
  const parts = (negative ? raw.slice(1) : raw).split(':')
  const [source, destination] = parts
  const valid = (value: string, pattern = false) =>
    value !== '@' &&
    (!value || isSafeGitRefName(`refs/${pattern ? value.replace('*', 'capture') : value}`))
  const stars = (value: string) => value.split('*').length - 1
  if (parts.length > 2 || !valid(source, true) || stars(source) > 1) {
    return { kind: 'invalid' }
  }
  if (negative) {
    return parts.length === 1 && source ? { kind: 'negative', source } : { kind: 'invalid' }
  }
  if (destination === undefined || destination === '') {
    return source.includes('*')
      ? { kind: 'invalid' }
      : { kind: destination === undefined ? 'no-store' : 'empty', source }
  }
  if (!valid(destination, true) || stars(destination) !== stars(source)) {
    return { kind: 'invalid' }
  }
  const stored = destination.startsWith('refs/')
    ? destination
    : /^(heads|tags|remotes)\//.test(destination)
      ? `refs/${destination}`
      : `refs/heads/${destination}`
  return { kind: 'mapped', source, destination: stored, trackingDestination: destination }
}

export function parseFetchMapping(spec: string): { source: string; destination: string } | null {
  const parsed = classifyFetchRefspec(spec)
  return parsed.kind === 'mapped' ? parsed : null
}

export function fetchMappingDomainsOverlap(left: string, right: string): boolean {
  const a = parseFetchMapping(left)
  const b = parseFetchMapping(right)
  if (!a || !b) {
    const kind = classifyFetchRefspec(right).kind
    return kind === 'invalid' || kind === 'mapped'
  }
  if (!a.destination.includes('*')) {
    return matchRefPattern(b.destination, a.destination) !== null
  }
  if (!b.destination.includes('*')) {
    return matchRefPattern(a.destination, b.destination) !== null
  }
  const [ap, az] = a.destination.split('*')
  const [bp, bz] = b.destination.split('*')
  return (ap.startsWith(bp) || bp.startsWith(ap)) && (az.endsWith(bz) || bz.endsWith(az))
}

/** Prove translation over the whole overlapping destination domain, including sibling refs. */
export function compatibleFetchMapping(proposed: string, existing: string): boolean {
  if (['negative', 'no-store', 'empty'].includes(classifyFetchRefspec(existing).kind)) {
    return true
  }
  const a = parseFetchMapping(proposed)
  const b = parseFetchMapping(existing)
  if (!a || !b) {
    return false
  }
  const [ap, az = ''] = a.destination.split('*')
  const [bp, bz = ''] = b.destination.split('*')
  if (!a.destination.includes('*')) {
    const capture = matchRefPattern(b.destination, a.destination)
    return capture === null || b.source.replace('*', capture) === a.source
  }
  if (!b.destination.includes('*')) {
    const capture = matchRefPattern(a.destination, b.destination)
    return capture === null || a.source.replace('*', capture) === b.source
  }
  if (!(ap.startsWith(bp) || bp.startsWith(ap)) || !(az.endsWith(bz) || bz.endsWith(az))) {
    return true
  }
  const [asp, asz = ''] = a.source.split('*')
  const [bsp, bsz = ''] = b.source.split('*')
  return (
    az === bz &&
    asz === bsz &&
    (ap.startsWith(bp) ? asp === bsp + ap.slice(bp.length) : bsp === asp + bp.slice(ap.length))
  )
}

/** Native ordered query is observable even where automatic writers are unsuitable. */
export function queryFetchTrackingRef(
  refspecs: readonly string[],
  source: string
): { kind: 'mapped'; destination: string } | { kind: 'absent' | 'invalid' } {
  const rows = refspecs.map(classifyFetchRefspec)
  if (rows.some((row) => row.kind === 'invalid')) {
    return { kind: 'invalid' }
  }
  if (rows.some((row) => row.kind === 'negative' && matchRefPattern(row.source, source) !== null)) {
    return { kind: 'absent' }
  }
  for (const row of rows) {
    if (row.kind !== 'mapped' && row.kind !== 'empty') {
      continue
    }
    const capture = matchRefPattern(row.source, source)
    if (capture === null) {
      continue
    }
    return row.kind === 'empty'
      ? { kind: 'absent' }
      : { kind: 'mapped', destination: row.trackingDestination.replace('*', capture) }
  }
  return { kind: 'absent' }
}

export function resolveFetchTrackingRef(
  refspecs: readonly string[],
  source: string
): string | undefined {
  const query = queryFetchTrackingRef(refspecs, source)
  if (query.kind !== 'mapped' || !query.destination.startsWith('refs/')) {
    return undefined
  }
  const target = query.destination
  const inverse = sourceRefsForTarget(refspecs, target)
  return !/^refs\/(heads|tags)\//.test(target) && inverse.length === 1 && inverse[0] === source
    ? target
    : undefined
}
