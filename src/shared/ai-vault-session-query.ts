import { isClipboardTextByteLengthOverLimit } from './clipboard-text'
import type { AiVaultSessionHost, AiVaultTimeRange } from './ai-vault-types'

export const AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES = 2 * 1024

const AI_SEARCH_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'we',
  'i',
  'my',
  'our',
  'that',
  'this',
  'those',
  'these',
  'where',
  'when',
  'how',
  'what',
  'which',
  'about',
  'from',
  'into',
  'was',
  'were',
  'did',
  'does',
  'is',
  'are',
  'be',
  'been',
  'it',
  'its'
])

export type ParsedVaultQuery = {
  terms: string[]
  repoTerms: string[]
  pathTerms: string[]
  modelTerms: string[]
  branchTerms: string[]
  hostTerms: AiVaultSessionHost[]
  afterMs: number | null
  beforeMs: number | null
}

export function isAiVaultSessionFilterQueryTooLarge(
  query: string,
  maxBytes = AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function parseVaultQuery(query: string): ParsedVaultQuery {
  const terms: string[] = []
  const repoTerms: string[] = []
  const pathTerms: string[] = []
  const modelTerms: string[] = []
  const branchTerms: string[] = []
  const hostTerms: AiVaultSessionHost[] = []
  let afterMs: number | null = null
  let beforeMs: number | null = null

  for (const rawToken of tokenizeQuery(query)) {
    const token = rawToken.toLowerCase()
    if (consumePrefixedTerm(token, 'repo:', repoTerms)) {
      continue
    }
    if (
      consumePrefixedTerm(token, 'path:', pathTerms) ||
      consumePrefixedTerm(token, 'cwd:', pathTerms)
    ) {
      continue
    }
    if (consumePrefixedTerm(token, 'model:', modelTerms)) {
      continue
    }
    if (consumePrefixedTerm(token, 'branch:', branchTerms)) {
      continue
    }
    if (token.startsWith('host:')) {
      const host = token.slice('host:'.length)
      if (host === 'local' || host === 'wsl') {
        hostTerms.push(host)
      }
      continue
    }
    if (token.startsWith('after:') || token.startsWith('since:')) {
      afterMs = parseQueryDateMs(token.slice(token.indexOf(':') + 1)) ?? afterMs
      continue
    }
    if (token.startsWith('before:')) {
      beforeMs = parseQueryDateMs(token.slice('before:'.length)) ?? beforeMs
      continue
    }
    terms.push(token)
  }

  return { terms, repoTerms, pathTerms, modelTerms, branchTerms, hostTerms, afterMs, beforeMs }
}

export function expandAiVaultSearchTerms(query: string): string[] {
  const parsed = parseVaultQuery(query)
  const expanded: string[] = []
  for (const term of parsed.terms) {
    for (const token of tokenizeIndexText(term)) {
      if (!AI_SEARCH_STOPWORDS.has(token) && !expanded.includes(token)) {
        expanded.push(token)
      }
    }
  }
  return expanded
}

export function timeRangeStartMs(range: AiVaultTimeRange, nowMs: number): number | null {
  if (range === '24h') {
    return nowMs - 24 * 60 * 60 * 1000
  }
  if (range === '7d') {
    return nowMs - 7 * 24 * 60 * 60 * 1000
  }
  if (range === '30d') {
    return nowMs - 30 * 24 * 60 * 60 * 1000
  }
  return null
}

export function tokenizeIndexText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2)
}

function consumePrefixedTerm(token: string, prefix: string, bucket: string[]): boolean {
  if (!token.startsWith(prefix)) {
    return false
  }
  const value = token.slice(prefix.length)
  if (value) {
    bucket.push(value)
  }
  return true
}

function parseQueryDateMs(value: string): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = []
  // Why: keep quoted operator values (repo:/path:/cwd:…) intact so labels and
  // paths containing spaces still match — e.g. path:"/Users/ada/My Project".
  const pattern =
    /(repo|path|cwd|model|branch|host|after|since|before):"([^"]+)"|(repo|path|cwd|model|branch|host|after|since|before):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(query)) !== null) {
    const operator = match[1] ?? match[3]
    const operatorValue = match[2] ?? match[4]
    if (operator && operatorValue?.trim()) {
      tokens.push(`${operator.toLowerCase()}:${operatorValue.trim()}`)
      continue
    }

    const token = match[5] ?? match[6] ?? match[7]
    if (token?.trim()) {
      tokens.push(token.trim())
    }
  }
  return tokens
}
