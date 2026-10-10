import { escapeRegex } from '../../../../shared/string-utils'

export type SearchReplaceQuery = {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
}

type CaseOp = 'u' | 'l' | 'U' | 'L'

type ReplacePiece =
  | { kind: 'text'; value: string; caseOps: CaseOp[] }
  | { kind: 'group'; index: number; caseOps: CaseOp[] }

export type CompiledSearchReplace = {
  regex: RegExp
  pieces: ReplacePiece[]
  preserveCase: boolean
}

export type SearchReplaceTarget = { line: number; column: number; matchLength: number }

// Why: ripgrep's word chars are Unicode \w; plain \w is the fallback when the pattern rejects the u flag.
const UNICODE_WORD_CHAR = '[\\p{L}\\p{N}\\p{M}_]'

// Why: ripgrep's \z/\A anchors throw under the u flag, and the non-u fallback would
// then read \z as a literal z. Translate them so the JS regex keeps ripgrep's meaning.
function translateRipgrepAnchors(source: string): string {
  return source
    .replace(/(^|[^\\])((?:\\\\)*)\\z/g, '$1$2$')
    .replace(/(^|[^\\])((?:\\\\)*)\\A/g, '$1$2^')
}

function compileRegex(query: SearchReplaceQuery): RegExp {
  const source = query.useRegex ? translateRipgrepAnchors(query.query) : escapeRegex(query.query)
  const flags = query.caseSensitive ? 'g' : 'gi'
  const build = (unicode: boolean): RegExp => {
    const wordChar = unicode ? UNICODE_WORD_CHAR : '\\w'
    const wrapped = query.wholeWord ? `(?<!${wordChar})(?:${source})(?!${wordChar})` : source
    return new RegExp(wrapped, unicode ? `${flags}u` : flags)
  }
  try {
    return build(true)
  } catch {
    return build(false)
  }
}

/** Parses VS Code-style replace strings: `$n`, `$&`, `$$`, and in regex mode `\n`, `\t`, `\\`, `\u`, `\l`, `\U`, `\L`. */
export function parseReplacePattern(replaceText: string, useRegex: boolean): ReplacePiece[] {
  if (!useRegex) {
    return [{ kind: 'text', value: replaceText, caseOps: [] }]
  }
  const pieces: ReplacePiece[] = []
  let text = ''
  let pendingOps: CaseOp[] = []
  const flushText = (): void => {
    if (text) {
      pieces.push({ kind: 'text', value: text, caseOps: pendingOps })
      pendingOps = []
      text = ''
    }
  }
  for (let i = 0; i < replaceText.length; i++) {
    const ch = replaceText[i]
    const next = replaceText[i + 1]
    if (ch === '\\' && next !== undefined) {
      if (next === 'n' || next === 't' || next === '\\') {
        text += next === 'n' ? '\n' : next === 't' ? '\t' : '\\'
        i++
        continue
      }
      if (next === 'u' || next === 'l' || next === 'U' || next === 'L') {
        flushText()
        pendingOps.push(next)
        i++
        continue
      }
    }
    if (ch === '$' && next !== undefined) {
      if (next === '$') {
        text += '$'
        i++
        continue
      }
      if (next === '&') {
        flushText()
        pieces.push({ kind: 'group', index: 0, caseOps: pendingOps })
        pendingOps = []
        i++
        continue
      }
      const digits = /^\d{1,2}/.exec(replaceText.slice(i + 1))?.[0]
      if (digits) {
        flushText()
        pieces.push({ kind: 'group', index: Number(digits), caseOps: pendingOps })
        pendingOps = []
        i += digits.length
        continue
      }
    }
    text += ch
  }
  flushText()
  return pieces
}

function applyCaseOps(value: string, ops: readonly CaseOp[]): string {
  let result = value
  for (const op of ops) {
    if (op === 'U') {
      result = result.toUpperCase()
    } else if (op === 'L') {
      result = result.toLowerCase()
    } else if (result) {
      const head = String.fromCodePoint(result.codePointAt(0) ?? 0)
      const first = op === 'u' ? head.toUpperCase() : head.toLowerCase()
      result = first + result.slice(head.length)
    }
  }
  return result
}

function preserveSegmentCase(matched: string, replacement: string): string {
  if (!matched || !replacement) {
    return replacement
  }
  if (matched.toUpperCase() === matched && matched.toLowerCase() !== matched) {
    return replacement.toUpperCase()
  }
  if (matched.toLowerCase() === matched) {
    return replacement.toLowerCase()
  }
  // Why: code-point heads keep `\u`/`\l` working for astral cased scripts (e.g. Deseret).
  const matchedHead = String.fromCodePoint(matched.codePointAt(0) ?? 0)
  const replacementHead = String.fromCodePoint(replacement.codePointAt(0) ?? 0)
  if (matchedHead.toUpperCase() === matchedHead && matchedHead.toLowerCase() !== matchedHead) {
    return replacementHead.toUpperCase() + replacement.slice(replacementHead.length)
  }
  return replacementHead.toLowerCase() + replacement.slice(replacementHead.length)
}

/** Mirrors VS Code's Preserve Case: match casing, per `-`/`_` segment when both sides split alike. */
export function buildCasePreservedReplacement(matched: string, replacement: string): string {
  for (const separator of ['-', '_']) {
    const other = separator === '-' ? '_' : '-'
    const matchedParts = matched.split(separator)
    const replacementParts = replacement.split(separator)
    if (
      matchedParts.length > 1 &&
      matchedParts.length === replacementParts.length &&
      !(matched.includes(other) && replacement.includes(other))
    ) {
      return replacementParts
        .map((part, index) => preserveSegmentCase(matchedParts[index], part))
        .join(separator)
    }
  }
  return preserveSegmentCase(matched, replacement)
}

export function compileSearchReplace(
  query: SearchReplaceQuery,
  replaceText: string,
  preserveCase: boolean
): CompiledSearchReplace {
  return {
    regex: compileRegex(query),
    pieces: parseReplacePattern(replaceText, query.useRegex),
    preserveCase
  }
}

export function buildMatchReplacement(
  compiled: CompiledSearchReplace,
  match: RegExpExecArray
): string {
  const replacement = compiled.pieces
    .map((piece) =>
      applyCaseOps(piece.kind === 'text' ? piece.value : (match[piece.index] ?? ''), piece.caseOps)
    )
    .join('')
  return compiled.preserveCase ? buildCasePreservedReplacement(match[0], replacement) : replacement
}

function* lineMatches(regex: RegExp, line: string): Generator<RegExpExecArray> {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    yield match
    if (match[0] === '') {
      regex.lastIndex += regex.unicode && (line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1
    }
  }
}

/**
 * Replaces only the JS matches that sit exactly where the search reported one, so a regex
 * dialect gap or an edit since the search can never change text the user did not preview.
 */
export function replaceInText(
  content: string,
  compiled: CompiledSearchReplace,
  targets: readonly SearchReplaceTarget[]
): { content: string; count: number } {
  const targetsByLine = new Map<number, Set<string>>()
  for (const target of targets) {
    const key = `${target.column}:${target.matchLength}`
    targetsByLine.set(target.line, (targetsByLine.get(target.line) ?? new Set()).add(key))
  }
  const lines = content.split('\n')
  let count = 0
  for (const [lineNumber, keys] of targetsByLine) {
    const raw = lines[lineNumber - 1]
    if (raw === undefined) {
      continue
    }
    // Why: keep CRLF intact; matching the bare line stops `$` or `\s` from eating the `\r`.
    const eol = raw.endsWith('\r') ? '\r' : ''
    const line = eol ? raw.slice(0, -1) : raw
    let next = ''
    let cursor = 0
    let replaced = false
    for (const match of lineMatches(compiled.regex, line)) {
      if (!keys.has(`${match.index + 1}:${match[0].length}`)) {
        continue
      }
      const replacement = buildMatchReplacement(compiled, match)
      next += line.slice(cursor, match.index)
      next += eol ? replacement.replace(/\r?\n/g, '\r\n') : replacement
      cursor = match.index + match[0].length
      replaced = true
      count++
    }
    if (replaced) {
      lines[lineNumber - 1] = next + line.slice(cursor) + eol
    }
  }
  return { content: count > 0 ? lines.join('\n') : content, count }
}

/** Replacement for the match at `column` (1-based), or null if JS sees a different match there. */
export function previewLineReplacement(
  compiled: CompiledSearchReplace,
  lineContent: string,
  column: number,
  matchLength: number
): string | null {
  for (const match of lineMatches(compiled.regex, lineContent.replace(/\r$/, ''))) {
    if (match.index === column - 1) {
      return match[0].length === matchLength ? buildMatchReplacement(compiled, match) : null
    }
    if (match.index > column - 1) {
      break
    }
  }
  return null
}
