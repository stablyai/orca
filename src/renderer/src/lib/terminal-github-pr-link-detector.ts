import type { RepoSlug } from './github-links'
import { parseGitHubIssueOrPRLink } from './github-links'

const GITHUB_PR_URL_RE =
  /\bhttps?:\/\/[A-Za-z0-9][A-Za-z0-9_.-]*(?::\d+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s"'<>]*)?/gi
const GITHUB_PR_PATH_MARKER = '/pull/'
const HTTP_SCHEME_PREFIXES = ['https://', 'http://'] as const
const TRAILING_TERMINAL_PUNCTUATION_RE = /[),.;\]}]+$/
const MAX_CARRY_LENGTH = 512

export type TerminalGitHubPRLink = {
  url: string
  slug: RepoSlug
  number: number
}

function trimTerminalUrl(candidate: string): string {
  return candidate.replace(TRAILING_TERMINAL_PUNCTUATION_RE, '')
}

function parseTerminalGitHubPRUrl(candidate: string): TerminalGitHubPRLink | null {
  const url = trimTerminalUrl(candidate)
  const parsed = parseGitHubIssueOrPRLink(url)
  if (!parsed || parsed.type !== 'pr') {
    return null
  }
  return { url, slug: parsed.slug, number: parsed.number }
}

function endsWithHttpSchemePrefixFragment(value: string): string {
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    for (let length = Math.min(prefix.length - 1, value.length); length > 0; length--) {
      if (value.endsWith(prefix.slice(0, length))) {
        return value.slice(value.length - length)
      }
    }
  }
  return ''
}

function getPotentialGitHubPRCarry(value: string): string {
  const schemeIndex = Math.max(...HTTP_SCHEME_PREFIXES.map((prefix) => value.lastIndexOf(prefix)))
  if (schemeIndex !== -1) {
    const tail = value.slice(schemeIndex)
    return /\s/.test(tail) ? '' : tail.slice(-MAX_CARRY_LENGTH)
  }

  return endsWithHttpSchemePrefixFragment(value)
}

export function createTerminalGitHubPRLinkDetector(): (data: string) => TerminalGitHubPRLink[] {
  let carry = ''
  const seenUrls = new Set<string>()

  return (data: string): TerminalGitHubPRLink[] => {
    const combined = carry ? carry + data : data

    if (!combined.includes(GITHUB_PR_PATH_MARKER)) {
      carry = getPotentialGitHubPRCarry(combined)
      return []
    }

    const links: TerminalGitHubPRLink[] = []
    for (const match of combined.matchAll(GITHUB_PR_URL_RE)) {
      const rawUrl = match[0]
      const matchEnd = (match.index ?? 0) + rawUrl.length
      // Why: PTY chunks can split the PR number; wait for a boundary before
      // treating a URL at chunk-end as complete.
      if (matchEnd === combined.length) {
        continue
      }

      const parsed = parseTerminalGitHubPRUrl(rawUrl)
      if (!parsed || seenUrls.has(parsed.url)) {
        continue
      }
      seenUrls.add(parsed.url)
      links.push(parsed)
    }

    carry = getPotentialGitHubPRCarry(combined)
    return links
  }
}
