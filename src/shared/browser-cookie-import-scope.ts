import { parse } from 'tldts'
import type { BrowserCookieImportScope } from './types'

const MAX_COOKIE_IMPORT_SCOPE_DOMAINS = 16
const MAX_COOKIE_IMPORT_DOMAIN_LENGTH = 253
const MAX_COOKIE_IMPORT_SCOPE_LABEL_LENGTH = 80

function normalizeScopeLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const label = value.trim().replace(/\s+/g, ' ')
  return label && label.length <= MAX_COOKIE_IMPORT_SCOPE_LABEL_LENGTH ? label : null
}

function parseHttpsHomeHostname(homeUrl: unknown): string | null {
  if (typeof homeUrl !== 'string' || !homeUrl.trim()) {
    return null
  }
  try {
    const parsedUrl = new URL(homeUrl.trim())
    if (
      parsedUrl.protocol !== 'https:' ||
      parsedUrl.username ||
      parsedUrl.password ||
      !parsedUrl.hostname
    ) {
      return null
    }
    return parsedUrl.hostname.toLowerCase()
  } catch {
    return null
  }
}

export function normalizeBrowserCookieDomain(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const candidate = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  if (
    !candidate ||
    candidate.length > MAX_COOKIE_IMPORT_DOMAIN_LENGTH ||
    candidate.includes('*') ||
    /[\s/@:\\?#]/.test(candidate) ||
    candidate.includes('..')
  ) {
    return null
  }
  let hostname: string
  try {
    hostname = new URL(`https://${candidate}/`).hostname.toLowerCase()
  } catch {
    return null
  }
  if (hostname.length > MAX_COOKIE_IMPORT_DOMAIN_LENGTH) {
    return null
  }
  const validLabels = hostname
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  if (!validLabels) {
    return null
  }
  const parsed = parse(hostname, { allowPrivateDomains: true })
  // Why: private suffixes such as github.io isolate tenants just like ICANN
  // suffixes, so neither class is safe as a broad cookie import scope.
  if (parsed.isIp || !parsed.domain || parsed.publicSuffix === hostname) {
    return null
  }
  return hostname
}

export function normalizeBrowserCookieImportScope(value: unknown): BrowserCookieImportScope | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  const label = normalizeScopeLabel(candidate.label)
  const sourceHostname = normalizeBrowserCookieDomain(candidate.sourceHostname)
  if (
    !label ||
    !sourceHostname ||
    !Array.isArray(candidate.domains) ||
    candidate.domains.length === 0 ||
    candidate.domains.length > MAX_COOKIE_IMPORT_SCOPE_DOMAINS
  ) {
    return null
  }
  const domains: string[] = []
  const seen = new Set<string>()
  for (const value of candidate.domains) {
    const domain = normalizeBrowserCookieDomain(value)
    if (!domain) {
      return null
    }
    if (!seen.has(domain)) {
      seen.add(domain)
      domains.push(domain)
    }
  }
  if (
    domains.some((domain) => sourceHostname !== domain && !sourceHostname.endsWith(`.${domain}`))
  ) {
    return null
  }
  return { label, domains, sourceHostname }
}

export function deriveBrowserCookieDomainsFromHomeUrl(homeUrl: unknown): string[] | null {
  const hostname = parseHttpsHomeHostname(homeUrl)
  if (!hostname) {
    return null
  }
  const parsed = parse(hostname, { allowPrivateDomains: true })
  const domain = parsed.domain ?? (!parsed.isIp && !parsed.publicSuffix ? hostname : null)
  const normalizedDomain = normalizeBrowserCookieDomain(domain)
  return normalizedDomain ? [normalizedDomain] : null
}

export function normalizeBrowserCookieImportScopeForHome(
  value: unknown,
  homeUrl: unknown
): BrowserCookieImportScope | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const hostname = parseHttpsHomeHostname(homeUrl)
  if (!hostname) {
    return null
  }
  const candidate = value as Record<string, unknown>
  const domains =
    Array.isArray(candidate.domains) && candidate.domains.length > 0
      ? candidate.domains
      : deriveBrowserCookieDomainsFromHomeUrl(homeUrl)
  return normalizeBrowserCookieImportScope({ ...candidate, domains, sourceHostname: hostname })
}

export function browserCookieDomainMatchesScope(
  cookieDomain: string,
  scope: { domains: readonly string[] }
): boolean {
  const normalizedCookieDomain = normalizeBrowserCookieDomain(cookieDomain)
  return Boolean(
    normalizedCookieDomain &&
    scope.domains.some(
      (domain) => normalizedCookieDomain === domain || normalizedCookieDomain.endsWith(`.${domain}`)
    )
  )
}

export function isGoogleCookieImportScope(scope: { domains: readonly string[] }): boolean {
  return scope.domains.some((domain) => domain === 'google.com' || domain.endsWith('.google.com'))
}
