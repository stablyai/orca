const MAX_BROWSER_ALLOWED_DOMAINS = 64
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeBrowserAllowedDomains(domains: readonly string[]): string[] {
  if (domains.length === 0 || domains.length > MAX_BROWSER_ALLOWED_DOMAINS) {
    throw new Error(`allowedDomains must contain 1-${MAX_BROWSER_ALLOWED_DOMAINS} entries`)
  }

  const normalized = new Set<string>()
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase()
    const wildcard = domain.startsWith('*.')
    const hostname = wildcard ? domain.slice(2) : domain
    if (
      !hostname ||
      !DOMAIN_PATTERN.test(hostname) ||
      domain.includes('@') ||
      domain.includes(':') ||
      domain.includes('/') ||
      domain === '*' ||
      (wildcard && (!hostname.includes('.') || hostname === 'localhost'))
    ) {
      throw new Error(`Invalid browser allowed domain: ${raw}`)
    }
    normalized.add(domain)
  }
  return [...normalized]
}

export function isBrowserNetworkUrlAllowed(
  rawUrl: string,
  allowedDomains: readonly string[]
): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol === 'about:') {
    return rawUrl === 'about:blank'
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return true
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  return allowedDomains.some((domain) => {
    if (!domain.startsWith('*.')) {
      return hostname === domain
    }
    const suffix = domain.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  })
}
