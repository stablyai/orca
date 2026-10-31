/* eslint-disable no-control-regex -- ANSI SGR sequences are raw PTY input. */
/** Share chunk carry and dedupe across main’s local/SSH fact scan and renderer remote-runtime/kill-switch byte scans. */
import type { RepoSlug } from './github/links'
import { parseGitHubIssueOrPRLink } from './github/links'

const GITHUB_PR_PATH_MARKER = '/pull/'
const TERMINAL_SGR_PATTERN = /\x1b\[[0-?]*[ -/]*m/g
const TERMINAL_CURSOR_CONTROL_PATTERN = /[\x08\x0b\x0c]/g
const TERMINAL_CONTROL_GUARD = '\ufffd'
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
  if (candidate.includes('\x1b') || candidate.includes(TERMINAL_CONTROL_GUARD)) {
    return null
  }
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

function lastIndexOfHttpScheme(value: string, fromIndex?: number): number {
  let lastIndex = -1
  for (const prefix of HTTP_SCHEME_PREFIXES) {
    const candidate =
      fromIndex === undefined ? value.lastIndexOf(prefix) : value.lastIndexOf(prefix, fromIndex)
    if (candidate > lastIndex) {
      lastIndex = candidate
    }
  }
  return lastIndex
}

function getPotentialGitHubPRCarry(value: string): string {
  // Only the capped suffix can survive; avoid a full-chunk scan on every PTY write.
  const windowStart = value.length > MAX_CARRY_LENGTH ? value.length - MAX_CARRY_LENGTH : 0
  const tailWindow = windowStart === 0 ? value : value.slice(windowStart)
  const schemeIndexInWindow = lastIndexOfHttpScheme(tailWindow)
  if (schemeIndexInWindow !== -1) {
    const schemeIndex = windowStart + schemeIndexInWindow
    return hasTerminalUrlWhitespace(value, schemeIndex, value.length)
      ? ''
      : value.slice(schemeIndex)
  }

  const fragment = endsWithHttpSchemePrefixFragment(tailWindow)
  if (fragment === '' || windowStart === 0) {
    return fragment
  }
  // An earlier scheme already exceeded the cap; do not resurrect that abandoned URL from a suffix fragment.
  return lastIndexOfHttpScheme(value, windowStart - 1) === -1 ? fragment : ''
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
  const nextSchemeIndexes = HTTP_SCHEME_PREFIXES.map((prefix) => value.indexOf(prefix))
  let searchStart = 0

  while (searchStart < value.length) {
    let candidateStart = -1
    for (const index of nextSchemeIndexes) {
      if (index !== -1 && (candidateStart === -1 || index < candidateStart)) {
        candidateStart = index
      }
    }
    if (candidateStart === -1) {
      return
    }

    const candidateEnd = findTerminalUrlCandidateEnd(value, candidateStart)
    const rawUrl = value.slice(candidateStart, candidateEnd)
    searchStart = Math.max(candidateEnd, candidateStart + 1)
    for (let index = 0; index < HTTP_SCHEME_PREFIXES.length; index++) {
      if (nextSchemeIndexes[index] !== -1 && nextSchemeIndexes[index]! < searchStart) {
        nextSchemeIndexes[index] = value.indexOf(HTTP_SCHEME_PREFIXES[index]!, searchStart)
      }
    }
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
    const rawCombined = carry ? carry + data : data

    // Skip multi-pass normalization when the chunk cannot contain a PR URL.
    if (!rawCombined.includes(GITHUB_PR_PATH_MARKER)) {
      carry = getPotentialGitHubPRCarry(rawCombined)
      return []
    }
    // Why: SGR styling has no screen width, so removing it is safe. Cursor
    // controls get a guard; other escape sequences remain URL-invalid.
    const combined = rawCombined
      .replace(TERMINAL_SGR_PATTERN, '')
      .replace(TERMINAL_CURSOR_CONTROL_PATTERN, TERMINAL_CONTROL_GUARD)

    const links: TerminalGitHubPRLink[] = []
    // Scan candidates directly so huge pasted lines containing /pull/ do not trigger a whole-chunk global regex.
    for (const { rawUrl, endIndex } of iterateTerminalUrlCandidates(combined)) {
      // Wait for a boundary: more PR-number digits may arrive in the next chunk.
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

    carry = getPotentialGitHubPRCarry(rawCombined)
    return links
  }
}
