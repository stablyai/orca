// Hostname routing for `contributes.linkRoutes`. Matching is label comparison, never a RegExp built
// from manifest text, so a hostile pattern cannot backtrack. The public-suffix check that completes
// the safety floor runs in main (see plugin-link-route-suffix-policy), because it needs `tldts`.

export type LinkRouteDestination = 'orca-browser' | 'system-browser'

export type NormalizedRoutePattern =
  | { kind: 'exact'; host: string }
  /** `*.example.com` — replaces exactly one label. Never crosses a dot. */
  | { kind: 'label'; tail: string }
  /** `*-loopspark.test` — reserved TLDs only. Crosses dots. */
  | { kind: 'midlabel'; tail: string }

export type NormalizedLinkRoute = {
  pattern: NormalizedRoutePattern
  destination: LinkRouteDestination
  pluginKey: string
  index: number
}

export const LINK_ROUTE_MAX_HOSTNAME_LENGTH = 253

// RFC 6761 / RFC 2606. These can never be publicly registered, so a wildcard inside a registrable
// label cannot capture real traffic — the only reason mid-label wildcards are allowed at all.
const RESERVED_TLDS = new Set(['test', 'localhost', 'local', 'internal', 'example', 'invalid'])

// Below this, a mid-label wildcard covers most of a dev namespace (`*x.test`).
const MIN_MIDLABEL_LITERAL_LENGTH = 6

const FORBIDDEN_PATTERN_CHARS = /[@/\\?#%:\s]/

function stripTrailingDot(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value
}

function hasEmptyLabel(value: string): boolean {
  return value.length === 0 || value.split('.').some((label) => label.length === 0)
}

function isValidDnsLabel(label: string): boolean {
  return label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
}

/**
 * IDNA/UTS-46 via the URL parser. Must run BEFORE case folding: UTS-46 folding is not
 * `toLowerCase()` (Greek final sigma diverges), so lowercasing first yields a different punycode
 * string than the browser produces for the same host.
 */
function toAsciiHostname(value: string): string | null {
  try {
    const hostname = new URL(`http://${value}`).hostname
    return hostname.length > 0 ? hostname : null
  } catch {
    return null
  }
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    return true
  }
  const labels = hostname.split('.')
  // `new URL` canonicalizes 127.1, 2130706433 and 0x7f.1 into dotted-quad form.
  return labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label))
}

/**
 * Canonicalize a candidate host for matching. Returns null for IP literals and anything unparseable,
 * so neither can ever satisfy a wildcard route.
 */
export function normalizeHostForMatch(hostname: string): string | null {
  const ascii = toAsciiHostname(stripTrailingDot(hostname.trim()))
  if (!ascii || isIpLiteral(ascii)) {
    return null
  }
  const host = stripTrailingDot(ascii)
  if (hasEmptyLabel(host) || host.length > LINK_ROUTE_MAX_HOSTNAME_LENGTH) {
    return null
  }
  return host.split('.').every(isValidDnsLabel) ? host : null
}

function tailIsWellFormed(tail: string, skipFirstLabel: boolean): boolean {
  const labels = tail.split('.')
  if (labels.length < 2 || hasEmptyLabel(tail)) {
    return false
  }
  const checked = skipFirstLabel ? labels.slice(1) : labels
  if (!checked.every(isValidDnsLabel)) {
    return false
  }
  const finalLabel = labels.at(-1) ?? ''
  return finalLabel.length >= 2 && /^(?:[a-z]+|xn--[a-z0-9-]+)$/.test(finalLabel)
}

/**
 * Validate and canonicalize a manifest pattern. Shape rules only — the public-suffix rejection that
 * kills `*.com` and `*.co.uk` is a separate main-process stage.
 */
export function normalizeRoutePattern(raw: string): NormalizedRoutePattern | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > LINK_ROUTE_MAX_HOSTNAME_LENGTH + 2) {
    return null
  }

  const starCount = (trimmed.match(/\*/g) ?? []).length
  if (starCount > 1 || (starCount === 1 && !trimmed.startsWith('*'))) {
    return null
  }
  const body = starCount === 1 ? trimmed.slice(1) : trimmed
  if (FORBIDDEN_PATTERN_CHARS.test(body)) {
    return null
  }

  if (starCount === 0) {
    const host = normalizeHostForMatch(body)
    return host ? { kind: 'exact', host } : null
  }

  if (body.startsWith('.')) {
    const tail = normalizeHostForMatch(body.slice(1))
    if (!tail || !tailIsWellFormed(tail, false)) {
      return null
    }
    return { kind: 'label', tail }
  }

  // Mid-label: the wildcard sits inside the registrable label, so restrict it to reserved TLDs.
  // `*e.com` would otherwise pass a whole-tail public-suffix test and capture google.com, apple.com…
  const firstDot = body.indexOf('.')
  if (firstDot <= 0) {
    return null
  }
  const literalPrefix = body.slice(0, firstDot)
  if (literalPrefix.length < MIN_MIDLABEL_LITERAL_LENGTH) {
    return null
  }
  // The wildcard-bearing label legitimately starts with `-`, which fails an LDH label check, so it
  // is validated as a suffix fragment instead of a label.
  if (!/^[a-z0-9-]+$/i.test(literalPrefix)) {
    return null
  }
  // Prefix a filler letter so the wildcard-bearing label is a parseable label for IDNA, then drop it.
  const ascii = toAsciiHostname(`w${body}`)
  if (!ascii) {
    return null
  }
  const tail = stripTrailingDot(ascii).slice(1)
  if (!tailIsWellFormed(tail, true)) {
    return null
  }
  const finalLabel = tail.split('.').pop() ?? ''
  if (!RESERVED_TLDS.has(finalLabel)) {
    return null
  }
  return { kind: 'midlabel', tail }
}

/** Canonical ascii text for a pattern. Used for storage, consent rendering and the fingerprint. */
export function formatRoutePattern(pattern: NormalizedRoutePattern): string {
  switch (pattern.kind) {
    case 'exact':
      return pattern.host
    case 'label':
      return `*.${pattern.tail}`
    case 'midlabel':
      return `*${pattern.tail}`
  }
}

function patternMatches(pattern: NormalizedRoutePattern, host: string): boolean {
  switch (pattern.kind) {
    case 'exact':
      return host === pattern.host
    case 'label': {
      const suffix = `.${pattern.tail}`
      if (!host.endsWith(suffix)) {
        return false
      }
      const prefix = host.slice(0, -suffix.length)
      return prefix.length > 0 && !prefix.includes('.')
    }
    case 'midlabel':
      return host.length > pattern.tail.length && host.endsWith(pattern.tail)
  }
}

function patternWeight(pattern: NormalizedRoutePattern): number {
  return pattern.kind === 'exact' ? pattern.host.length : pattern.tail.length
}

/** Total, install-order-independent ordering. First match wins at click time. */
export function rankLinkRoutes(routes: readonly NormalizedLinkRoute[]): NormalizedLinkRoute[] {
  return [...routes].sort((a, b) => {
    if (a.pattern.kind !== b.pattern.kind) {
      if (a.pattern.kind === 'exact') {
        return -1
      }
      if (b.pattern.kind === 'exact') {
        return 1
      }
    }
    const weight = patternWeight(b.pattern) - patternWeight(a.pattern)
    if (weight !== 0) {
      return weight
    }
    const key = a.pluginKey.localeCompare(b.pluginKey)
    return key !== 0 ? key : a.index - b.index
  })
}

/**
 * Resolve a clicked URL against the approved route table. Returns null for anything that must keep
 * today's behavior: non-http(s), credential-bearing, unparseable, IP literal, or simply unmatched.
 */
export function matchLinkRoute(
  url: string,
  routes: readonly NormalizedLinkRoute[]
): NormalizedLinkRoute | null {
  if (routes.length === 0) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  // Credentials in the URL are never silently re-homed into a session that may hold real cookies.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return null
  }
  const host = normalizeHostForMatch(parsed.hostname)
  if (!host) {
    return null
  }
  return routes.find((route) => patternMatches(route.pattern, host)) ?? null
}
