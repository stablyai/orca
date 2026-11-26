import { isEligibleLocalCertificateHost, isWildcardBindHost } from './browser-url'

/** An http(s) URL naming the loopback of whichever machine opens it, including wildcard binds. */
export function isLoopbackBrowserUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (isWildcardBindHost(parsed.hostname) || isEligibleLocalCertificateHost(parsed.hostname))
    )
  } catch {
    return false
  }
}
