import { TextDocument, type Range } from '@pierre/diffs/edit'
import { isWholeWordMatch } from '../markdown-preview-search'

export type DiffSearchQuery = {
  text: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}
export type DiffSearchMatch = { range: Range; start: number; end: number; replacement: string }
export type DiffSearchRequest = { text: string; query: DiffSearchQuery; replacement: string }
export type DiffSearchResult = {
  matches: DiffSearchMatch[]
  truncated: boolean
  errorCode?: DiffSearchError
}
export type DiffSearchError =
  | 'invalid-regex'
  | 'replacement-too-large'
  | 'search-failed'
  | 'invalid-result'
  | 'timeout'
  | 'start-failed'
export const MAX_DIFF_SEARCH_MATCHES = 10_000

function replacementText(template: string, match: RegExpExecArray, text: string): string {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, name: string) => {
    if (name === '$') {
      return '$'
    }
    if (name === '&') {
      return match[0]
    }
    if (name === '`') {
      return text.slice(0, match.index)
    }
    if (name === "'") {
      return text.slice(match.index + match[0].length)
    }
    if (name.startsWith('<')) {
      return match.groups ? (match.groups[name.slice(1, -1)] ?? '') : token
    }
    const index = Number(name)
    if (index > 0 && index < match.length) {
      return match[index] ?? ''
    }
    const first = Number(name[0])
    return name.length === 2 && first > 0 && first < match.length
      ? (match[first] ?? '') + name[1]
      : token
  })
}

// Runs only in a terminable worker; even pathological regexes cannot block typing.
export function searchPierreDiff({
  text,
  query,
  replacement
}: DiffSearchRequest): DiffSearchResult {
  if (!query.text) {
    return { matches: [], truncated: false }
  }
  const source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let pattern: RegExp
  try {
    pattern = new RegExp(source, query.matchCase ? 'gmu' : 'gimu')
  } catch {
    return { matches: [], truncated: false, errorCode: 'invalid-regex' }
  }
  const document = new TextDocument('diff-search', text)
  const matches: DiffSearchMatch[] = []
  let replacementCharacters = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const start = match.index
    const end = start + match[0].length
    if (!query.wholeWord || isWholeWordMatch(text, start, end)) {
      if (matches.length === MAX_DIFF_SEARCH_MATCHES) {
        return { matches, truncated: true }
      }
      const nextReplacement = query.regex ? replacementText(replacement, match, text) : replacement
      replacementCharacters += nextReplacement.length
      if (replacementCharacters > 16_000_000) {
        return { matches: [], truncated: false, errorCode: 'replacement-too-large' }
      }
      matches.push({
        start,
        end,
        range: { start: document.positionAt(start), end: document.positionAt(end) },
        replacement: nextReplacement
      })
    }
    if (start === end) {
      pattern.lastIndex += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1
    }
  }
  return { matches, truncated: false }
}
