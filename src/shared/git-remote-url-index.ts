// Why: "which remote has this URL?" was answered with one `git remote get-url`
// subprocess per remote, awaited serially -- 58 spawns on a repo with 58 remotes,
// on every push-target resolution. `git remote -v` answers for every remote from
// one child.
//
// `remote -v` is the faithful one-command form, not `config --get-regexp '^remote\.'`:
// both `remote -v` and `remote get-url` print the URL *after* `url.<base>.insteadOf`
// expansion and pick the first of several `remote.<name>.url` values, while raw config
// reads return the unexpanded value and the last of the multiple values.
//
// `remote -v` also predates `remote get-url` (2.7), so this lowers rather than raises
// the Git floor and needs no capability gate.

import { iterateProcessOutputLines } from './process-output-field-scanner'

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

/**
 * Fetch URL per remote in `git remote` order -- the value `git remote get-url <name>`
 * prints. A remote configured with only a `pushurl` has no fetch row and is absent
 * here; `get-url` echoed the remote's own name for it, which no caller can match.
 */
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
