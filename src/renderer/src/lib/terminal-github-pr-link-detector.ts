import type { RepoSlug } from './github-links'
import { parseGitHubIssueOrPRLink } from './github-links'

const GITHUB_PR_PATH_MARKER = '/pull/'
const HTTP_SCHEME_PREFIXES = ['https://', 'http://'] as const
const TRAILING_TERMINAL_PUNCTUATION_RE = /[),.;\]}]+$/
const MAX_CARRY_LENGTH = 512
const MAX_TERMINAL_GITHUB_PR_URL_LENGTH = 2048

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
    const tailLength = value.length - schemeIndex
    if (tailLength > MAX_CARRY_LENGTH) {
      return ''
    }
    return hasTerminalUrlWhitespace(value, schemeIndex, value.length)
      ? ''
      : value.slice(schemeIndex)
  }

  return endsWithHttpSchemePrefixFragment(value)
}

function hasTerminalUrlWhitespace(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (/\s/.test(value.charAt(index))) {
      return true
    }
  }
  return false
}

type TerminalUrlCandidate = {
  rawUrl: string
  endIndex: number
}

function findNextHttpSchemeIndex(value: string, start: number): number {
  let nextIndex = -1
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    const candidate = value.indexOf(prefix, start)
    if (candidate !== -1 && (nextIndex === -1 || candidate < nextIndex)) {
      nextIndex = candidate
    }
  }
  return nextIndex
}

function isTerminalUrlTerminator(char: string): boolean {
  return char === '"' || char === "'" || char === '<' || char === '>' || /\s/.test(char)
}

function findTerminalUrlCandidateEnd(value: string, start: number): number {
  const scanEnd = Math.min(value.length, start + MAX_TERMINAL_GITHUB_PR_URL_LENGTH + 1)
  for (let index = start; index < scanEnd; index += 1) {
    if (isTerminalUrlTerminator(value.charAt(index))) {
      return index
    }
  }
  return scanEnd
}

function* iterateTerminalUrlCandidates(value: string): Generator<TerminalUrlCandidate> {
  let searchStart = 0

  while (searchStart < value.length) {
    const candidateStart = findNextHttpSchemeIndex(value, searchStart)
    if (candidateStart === -1) {
      return
    }

    const candidateEnd = findTerminalUrlCandidateEnd(value, candidateStart)
    const rawUrl = value.slice(candidateStart, candidateEnd)
    searchStart = Math.max(candidateEnd, candidateStart + 1)
    if (
      rawUrl.length > MAX_TERMINAL_GITHUB_PR_URL_LENGTH ||
      !rawUrl.includes(GITHUB_PR_PATH_MARKER)
    ) {
      continue
    }

    yield { rawUrl, endIndex: candidateEnd }
  }
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
    // Why: PTY data may echo a huge pasted line. Scan URL candidates directly
    // instead of running a global regex across the whole chunk when it contains
    // a /pull/ substring.
    for (const { rawUrl, endIndex } of iterateTerminalUrlCandidates(combined)) {
      // Why: PTY chunks can split the PR number; wait for a boundary before
      // treating a URL at chunk-end as complete.
      if (endIndex === combined.length) {
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
