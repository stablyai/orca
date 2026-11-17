import { blankComments } from './source-comment-blanking'

/** `exportName` is the name the target module exports: a named export, `default`, or `*` for the module itself. */
export type ImportReference = { specifier: string; exportName: string }

// Clause characters exclude quotes, `;`, `=` and parentheses so a match cannot run across statements.
const FROM_DECLARATION =
  /\b(?:import|export)\b((?:(?!\b(?:import|export)\b)[^'"`;=()])*?)\bfrom\s*(['"])([^'"\n]+)\2/g
const BARE_SPECIFIER = /\b(?:import|require)\s*\(?\s*(['"])([^'"\n]+)\1/g
export const IDENTIFIER_SOURCE = '[\\p{ID_Start}_$][\\p{ID_Continue}$\\u200c\\u200d]*'
const IDENTIFIER = new RegExp(IDENTIFIER_SOURCE, 'gu')

type Word = { name: string; start: number; end: number }

function identifiers(text: string, base: number): Word[] {
  const found: Word[] = []
  for (const match of text.matchAll(IDENTIFIER)) {
    found.push({
      name: match[0],
      start: base + match.index,
      end: base + match.index + match[0].length
    })
  }
  return found
}

/** One `{ ... }` element as written: `name`, `name as alias`, with an optional `type` modifier. */
export function parseListElement(element: string): { name: string; alias: string } | null {
  const names = identifiers(element, 0).map((word) => word.name)
  // `type` is a modifier only when a name follows it; `{ type }` and `{ type as kind }` name `type`.
  const modifier = names[0] === 'type' && (names.length === 2 || names.length === 4) ? 1 : 0
  const [name, as, alias] = names.slice(modifier)
  if (!name || (as !== undefined && (as !== 'as' || !alias))) {
    return null
  }
  return { name, alias: alias ?? name }
}

function clauseExportName(clause: string, clauseStart: number, offset: number): string | null {
  const braceStart = clause.indexOf('{')
  const braceEnd = clause.lastIndexOf('}')
  const head = braceStart === -1 ? clause : clause.slice(0, braceStart)
  if (braceStart !== -1 && offset > clauseStart + braceStart && offset <= clauseStart + braceEnd) {
    let elementStart = braceStart + 1
    for (const element of clause.slice(braceStart + 1, braceEnd).split(',')) {
      const start = clauseStart + elementStart
      elementStart += element.length + 1
      if (offset >= start && offset <= start + element.length) {
        // An import element reads `exported as local`.
        return parseListElement(element)?.name ?? null
      }
    }
    return null
  }
  const star = head.indexOf('*')
  for (const word of identifiers(head, clauseStart)) {
    if (offset < word.start || offset > word.end || word.name === 'type' || word.name === 'as') {
      continue
    }
    return star !== -1 && word.start > clauseStart + star ? '*' : 'default'
  }
  return null
}

/**
 * Describe the import that owns `offset`: a binding in an import/re-export clause, or a module
 * specifier string. With `specifierOnly`, bindings are ignored; use it when nothing has confirmed
 * that the position is a real binding.
 */
export function findImportReferenceAt(
  rawSource: string,
  offset: number,
  options: { specifierOnly?: boolean } = {}
): ImportReference | null {
  const source = blankComments(rawSource)
  for (const match of source.matchAll(FROM_DECLARATION)) {
    const end = match.index + match[0].length
    if (offset < match.index || offset > end) {
      continue
    }
    const specifier = match[3]
    if (offset >= end - specifier.length - 2) {
      return { specifier, exportName: '*' }
    }
    if (options.specifierOnly) {
      return null
    }
    // Both keywords are six characters, so the clause starts right after them.
    const exportName = clauseExportName(match[1], match.index + 6, offset)
    return exportName ? { specifier, exportName } : null
  }
  for (const match of source.matchAll(BARE_SPECIFIER)) {
    const end = match.index + match[0].length
    if (offset >= end - match[2].length - 2 && offset <= end) {
      return { specifier: match[2], exportName: '*' }
    }
  }
  return null
}
