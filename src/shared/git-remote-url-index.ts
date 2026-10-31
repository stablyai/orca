// remote -v replaces serial get-url children with one while preserving insteadOf expansion and the first URL.
// Raw config differs: it is unexpanded and returns the last multivar. remote -v predates get-url (2.7), requiring no capability gate.

import { iterateProcessOutputLines } from './process-output-field-scanner'

export type GitRemoteVerboseEntry = {
  name: string
  url: string
  direction: 'fetch' | 'push'
}

/** Identity historically accepts whitespace delimiters and the first direction marker. */
export function parseGitRemoteVerboseLine(
  line: string,
  identity = false
): GitRemoteVerboseEntry | null {
  const match = /^(\S+)[\t ]+(.+)$/.exec(line.trim())
  if (!match) {
    return null
  }
  const pattern = identity
    ? /^(.*?)\s+\((fetch)\)(?:\s+\[.*\])?$/
    : /^(.*)\s+\((fetch|push)\)(?:\s+\[[^\]\r\n]*\])?$/
  // Sparse object names can contain ] and direction-looking path text.
  const sparse = /^(.*?)\s+\((fetch|push)\)\s+\[sparse:.*\]$/
  const value = identity
    ? pattern.exec(match[2])
    : (sparse.exec(match[2]) ?? pattern.exec(match[2]))
  return value
    ? { name: match[1], url: value[1], direction: value[2] === 'fetch' ? 'fetch' : 'push' }
    : null
}

export function parseGitRemoteNames(stdout: string): Set<string> {
  return new Set(
    [...iterateProcessOutputLines(stdout)].flatMap((line) => {
      const row = parseGitRemoteVerboseLine(line)
      const bare = /^(\S+)[\t ]*$/.exec(line)
      return row ? [row.name] : bare ? [bare[1]] : []
    })
  )
}

export function parseGitRemotePushUrls(stdout: string): Map<string, string[]> {
  const urls = new Map<string, string[]>()
  for (const line of iterateProcessOutputLines(stdout)) {
    const row = parseGitRemoteVerboseLine(line)
    if (row?.direction === 'push') {
      const values = urls.get(row.name) ?? []
      values.push(row.url)
      urls.set(row.name, values)
    }
  }
  return urls
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
