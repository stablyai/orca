import type { RepoSlug } from './github-links'
import { parseGitHubIssueOrPRLink } from './github-links'

const GITHUB_PR_URL_RE =
  /\bhttps:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+(?:[/?#][^\s"'<>]*)?/gi
const GITHUB_HOST_MARKER = 'github.com/'
const GITHUB_PR_PATH_MARKER = '/pull/'
const HTTPS_SCHEME_PREFIX = 'https://'
const HTTPS_SCHEME_FRAGMENT_LAST_CHARS = new Set('https:/'.split(''))
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

function endsWithHttpsSchemePrefixFragment(value: string): string {
  for (let length = Math.min(HTTPS_SCHEME_PREFIX.length - 1, value.length); length > 0; length--) {
    if (value.endsWith(HTTPS_SCHEME_PREFIX.slice(0, length))) {
      return value.slice(value.length - length)
    }
  }
  return ''
}

function getPotentialGitHubPRCarry(value: string, hasGitHubHost: boolean): string {
  if (hasGitHubHost) {
    const hostIndex = value.lastIndexOf(GITHUB_HOST_MARKER)
    const schemeIndex = value.lastIndexOf('https://', hostIndex)
    if (schemeIndex === -1) {
      return ''
    }

    const tail = value.slice(schemeIndex)
    return /\s/.test(tail) ? '' : tail.slice(-MAX_CARRY_LENGTH)
  }

  const schemeIndex = value.lastIndexOf('https://')
  if (schemeIndex !== -1) {
    const tail = value.slice(schemeIndex)
    return /\s/.test(tail) ? '' : tail.slice(-MAX_CARRY_LENGTH)
  }

  const lastChar = value.at(-1)
  if (!lastChar || !HTTPS_SCHEME_FRAGMENT_LAST_CHARS.has(lastChar)) {
    return ''
  }

  return endsWithHttpsSchemePrefixFragment(value)
}

export function createTerminalGitHubPRLinkDetector(): (data: string) => TerminalGitHubPRLink[] {
  let carry = ''
  const seenUrls = new Set<string>()

  return (data: string): TerminalGitHubPRLink[] => {
    const combined = carry ? carry + data : data
    const hasGitHubHost = combined.includes(GITHUB_HOST_MARKER)

    if (!hasGitHubHost || !combined.includes(GITHUB_PR_PATH_MARKER)) {
      carry = getPotentialGitHubPRCarry(combined, hasGitHubHost)
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

    carry = getPotentialGitHubPRCarry(combined, true)
    return links
  }
}
