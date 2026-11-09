// remote -v replaces serial get-url children with one while preserving insteadOf expansion and the first URL.
// Raw config differs: it is unexpanded and returns the last multivar. remote -v predates get-url (2.7), requiring no capability gate.

import { iterateProcessOutputLines } from '../../process-output-field-scanner'

export type GitRemoteVerboseEntry = {
  name: string
  url: string
  direction: 'fetch' | 'push'
}

// Greedy prefix so a URL containing spaces or parentheses keeps them.
const REMOTE_VERBOSE_URL_PATTERN = /^(.*) \((fetch|push)\)$/

/** Parse one `<name>\t<url> (fetch|push)` row. */
export function parseGitRemoteVerboseLine(line: string): GitRemoteVerboseEntry | null {
  const tabIndex = line.indexOf('\t')
  if (tabIndex === -1) {
    return null
  }
  const name = line.slice(0, tabIndex)
  const match = REMOTE_VERBOSE_URL_PATTERN.exec(line.slice(tabIndex + 1).trim())
  return match ? { name, url: match[1], direction: match[2] as 'fetch' | 'push' } : null
}

/** First fetch URL per remote, in git remote order, matching get-url. Pushurl-only remotes have no matchable fetch URL and are omitted. */
export function parseGitRemoteFetchUrls(stdout: string): Map<string, string> {
  const fetchUrls = new Map<string, string>()
  for (const line of iterateProcessOutputLines(stdout)) {
    const parsed = parseGitRemoteVerboseLine(line)
    // First wins: `get-url` without `--all` prints the first `remote.<name>.url`.
    if (parsed?.direction === 'fetch' && !fetchUrls.has(parsed.name)) {
      fetchUrls.set(parsed.name, parsed.url)
    }
  }
  return fetchUrls
}

/** First remote whose fetch URL matches, in the order the per-remote scan visited them. */
export function findGitRemoteNameByFetchUrl(
  stdout: string,
  matchesUrl: (url: string) => boolean
): string | null {
  for (const [name, url] of parseGitRemoteFetchUrls(stdout)) {
    if (matchesUrl(url)) {
      return name
    }
  }
  return null
}

/** URL as git prints it in a push's `To` line: `user[:pass]@` dropped, as transport_anonymize_url does. */
export function anonymizeGitRemoteUrl(url: string): string {
  return url.includes('://')
    ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, '$1')
    : url.replace(/^[^/@]+@(?=[^/]*:)/u, '')
}

/** The remote a push printed as `To <url>`, matched on its (insteadOf-expanded) push URL. */
export function findGitRemoteNameByPushedUrl(
  stdout: string,
  printedUrl: string,
  remoteName?: string
): string | null {
  for (const line of iterateProcessOutputLines(stdout)) {
    const parsed = parseGitRemoteVerboseLine(line)
    if (
      parsed?.direction === 'push' &&
      (!remoteName || parsed.name === remoteName) &&
      anonymizeGitRemoteUrl(parsed.url) === printedUrl
    ) {
      return parsed.name
    }
  }
  return null
}
