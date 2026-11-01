import { JIRA_ISSUE_KEY_PATTERN } from './jira-issue-url'

// JQL has a closed operator set (plugins add functions); without an operator/leading ORDER BY, treat input as text. Exclude hyphens for sign-in.
const JQL_OPERATOR_PATTERN = new RegExp(
  [
    '[=~<>]',
    String.raw`(?:^|[^\w-])(?:was|changed)(?![\w-])`,
    // IN requires a list/function; spaces before bare function names prevent input (raw) matching in + put(.
    String.raw`(?:^|[^\w-])in(?:\s+[a-z_][\w.]*|\s*"[^"]+"|\s*'[^']+')?\s*\(`,
    // IS takes only EMPTY or NULL, so `login is slow` cannot parse.
    String.raw`(?:^|[^\w-])is\s+(?:not\s+)?(?:empty|null)(?![\w-])`,
    String.raw`^order\s+by\b`
  ].join('|'),
  'i'
)

// Lucene text-search syntax. Jira's index drops these characters, so spaces keep matches intact.
const TEXT_SEARCH_SYNTAX_PATTERN = /[+\-&|!(){}[\]^"~*?:\\/]/g

// Why: Jira skips word-splitting for a wildcard term, so `login,*` or `c#*` match nothing.
const WILDCARD_SAFE_WORD_PATTERN = /^[\p{L}\p{N}']+$/u

export function mayBeJql(input: string): boolean {
  return JQL_OPERATOR_PATTERN.test(input.trim())
}

export function isBareJiraIssueNumber(input: string): boolean {
  return /^\d+$/.test(input.trim())
}

/** Issue keys the input names: itself when key-shaped, or a bare number within each of `projectKeys`. */
export function listJiraIssueKeyCandidates(
  input: string,
  projectKeys: readonly string[] = []
): string[] {
  const trimmed = input.trim()
  const candidates = isBareJiraIssueNumber(trimmed)
    ? projectKeys.map((projectKey) => `${projectKey}-${trimmed}`)
    : [trimmed]
  return [
    ...new Set(
      candidates.filter((key) => JIRA_ISSUE_KEY_PATTERN.test(key)).map((key) => key.toUpperCase())
    )
  ]
}

export function buildJiraIssueKeysJql(keys: readonly string[]): string {
  return keys.length === 1
    ? `key = "${keys[0]}"`
    : `key in (${keys.map((key) => `"${key}"`).join(', ')})`
}

/** Exact-issue-key JQL when the input is key-shaped, or a bare number within each of `projectKeys`. */
export function buildJiraIssueKeyJql(
  input: string,
  projectKeys: readonly string[] = []
): string | null {
  const keys = listJiraIssueKeyCandidates(input, projectKeys)
  return keys.length > 0 ? buildJiraIssueKeysJql(keys) : null
}

/** Search issue text, ignoring key shape. Empty when no searchable words remain. */
export function buildJiraTextMatchJql(input: string): string {
  // Why: uppercase AND/OR/NOT are Lucene operators; text search ignores case anyway.
  const words = input
    .replace(TEXT_SEARCH_SYNTAX_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (!words) {
    return ''
  }
  const lastWord = words.slice(words.lastIndexOf(' ') + 1)
  return `text ~ "${words}${WILDCARD_SAFE_WORD_PATTERN.test(lastWord) ? '*' : ''}"`
}
