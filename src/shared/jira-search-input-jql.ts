import { JIRA_ISSUE_KEY_PATTERN } from './jira-issue-url'

// Why: JQL's operator set is closed (plugins add functions, not operators), so input with none
// of these and no leading ORDER BY cannot parse as JQL. Hyphens excluded so `sign-in` stays text.
const JQL_OPERATOR_PATTERN = new RegExp(
  [
    '[=~<>]',
    String.raw`(?<![\w-])(?:was|changed)(?![\w-])`,
    // IN takes only a list or a function call, so `crash in terminal` cannot parse. The space
    // before a bare function name keeps `input (raw)` from reading as `in` + `put(`.
    String.raw`(?<![\w-])in(?:\s+[a-z_][\w.]*|\s*"[^"]+"|\s*'[^']+')?\s*\(`,
    // IS takes only EMPTY or NULL, so `login is slow` cannot parse.
    String.raw`(?<![\w-])is\s+(?:not\s+)?(?:empty|null)(?![\w-])`,
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

/** Exact-issue-key JQL when the whole input is key-shaped; null otherwise. */
export function buildJiraIssueKeyJql(input: string): string | null {
  const trimmed = input.trim()
  return JIRA_ISSUE_KEY_PATTERN.test(trimmed) ? `key = "${trimmed.toUpperCase()}"` : null
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
