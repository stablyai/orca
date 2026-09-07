import { translate } from '@/i18n/i18n'
import { isValid as isListedDomain } from 'psl'
import { classifySchemeLessLocalDevAddress } from '../../../../shared/browser-url'

const HOST_FILE_EXTENSIONS = new Set([
  'css',
  'html',
  'js',
  'jsx',
  'json',
  'md',
  'py',
  'toml',
  'ts',
  'tsx',
  'yaml',
  'yml'
])

const IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const HTTP_SCHEME_PATTERN = /^https?:\/\//i
const BRACKETED_IPV6_ATTEMPT_PATTERN = /^\[[0-9a-f:]+\](?::[^/?#]*)?(?:[/?#].*)?$/i
const SCHEME_PREFIX_PATTERN = /^[a-z][a-z0-9+.-]*:/i
const SCHEME_WITH_SLASHES_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i

export type ExplicitUrlClassification =
  | { kind: 'blocked'; message: string }
  | { kind: 'explicit-url'; url: string }

export type HostUrlClassification =
  | { kind: 'blocked'; message: string }
  | { kind: 'host-url'; url: string }

function invalidUrl(): { kind: 'blocked'; message: string } {
  return {
    kind: 'blocked',
    message: translate(
      'auto.components.tab.bar.tab.create.entry.classifier.90eb94dc48',
      'Enter an http:// or https:// URL.'
    )
  }
}

function parseHttpUrl(query: string): ExplicitUrlClassification {
  try {
    const url = new URL(query)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname
      ? { kind: 'explicit-url', url: url.href }
      : invalidUrl()
  } catch {
    return invalidUrl()
  }
}

function splitHostCandidate(query: string): { host: string; port: string | null } | null {
  if (/[\\\s]/.test(query)) {
    return null
  }

  // Keep the authority separate from the path/query/hash so domain URLs remain
  // navigations; known source extensions are excluded and exact files win later.
  const authorityEnd = query.search(/[/?#]/)
  const authority = authorityEnd === -1 ? query : query.slice(0, authorityEnd)
  const colonIndex = authority.indexOf(':')
  const host = colonIndex === -1 ? authority : authority.slice(0, colonIndex)
  const port = colonIndex === -1 ? null : authority.slice(colonIndex + 1)
  const extension = host.split('.').pop()?.toLowerCase() ?? ''
  if (HOST_FILE_EXTENSIONS.has(extension)) {
    return null
  }
  if (
    host.toLowerCase() !== 'localhost' &&
    !IPV4_PATTERN.test(host) &&
    (!DOMAIN_PATTERN.test(host) || (authorityEnd !== -1 && !isListedDomain(host)))
  ) {
    return null
  }
  return { host, port }
}

// Why: a bare LAN/dev address almost never serves TLS, but a public IP still
// deserves https — plaintext there would be a downgrade, and IPs get no HSTS.
function isPrivateIpv4(host: string): boolean {
  if (!IPV4_PATTERN.test(host)) {
    return false
  }
  const [first = 0, second = 0] = host.split('.').map(Number)
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) || // CGNAT, incl. Tailscale
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 168)
  )
}

function hasSourceExtensionBeforeColon(query: string): boolean {
  const colonIndex = query.indexOf(':')
  if (colonIndex === -1) {
    return false
  }
  const extension = query.slice(0, colonIndex).split('.').pop()?.toLowerCase() ?? ''
  return HOST_FILE_EXTENSIONS.has(extension)
}

export function classifyExplicitUrl(query: string): ExplicitUrlClassification | null {
  if (HTTP_SCHEME_PATTERN.test(query)) {
    return parseHttpUrl(query)
  }
  if (SCHEME_WITH_SLASHES_PATTERN.test(query)) {
    return invalidUrl()
  }
  if (classifySchemeLessLocalDevAddress(query)) {
    return null
  }
  if (splitHostCandidate(query)) {
    return null
  }
  if (hasSourceExtensionBeforeColon(query)) {
    return null
  }
  if (!SCHEME_PREFIX_PATTERN.test(query)) {
    return null
  }
  if (/\s/.test(query)) {
    return null
  }
  return invalidUrl()
}

export function classifyHostUrl(query: string): HostUrlClassification | null {
  const candidate = splitHostCandidate(query)
  if (!candidate) {
    const localDevUrl = classifySchemeLessLocalDevAddress(query)
    if (localDevUrl?.hostname) {
      return { kind: 'host-url', url: localDevUrl.href }
    }
    return BRACKETED_IPV6_ATTEMPT_PATTERN.test(query) ? invalidUrl() : null
  }
  if (candidate.port !== null && !/^\d+$/.test(candidate.port)) {
    // Why: "docker.io:latest" reads as a tag, not a URL attempt — fall through so
    // file matches and search still get offered instead of blocking every row.
    return null
  }
  try {
    const scheme =
      candidate.host.toLowerCase() === 'localhost' || isPrivateIpv4(candidate.host)
        ? 'http'
        : 'https'
    const url = new URL(`${scheme}://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : invalidUrl()
  } catch {
    return invalidUrl()
  }
}
