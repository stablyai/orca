export type ImportBinding = {
  local: string
  /** `default`, `*` for a namespace, or the exported name. */
  imported: string
  offset: number
}

export type ImportStatement = {
  start: number
  end: number
  specifier: string
  specifierStart: number
  specifierEnd: number
  bindings: ImportBinding[]
}

export type ImportNavigationRequest = {
  specifier: string
  /** Null when the module path itself was chosen. */
  importedName: string | null
}

const IDENTIFIER = '[A-Za-z_$][\\w$]*'
const IMPORT_FROM = new RegExp(
  `\\bimport\\s+(?:type\\s+)?((?:${IDENTIFIER}\\s*(?:,\\s*)?)?(?:\\*\\s*as\\s+${IDENTIFIER}|\\{[^}]*\\})?)\\s*from\\s*(['"])([^'"\\r\\n]+)\\2`,
  'g'
)
const EXPORT_FROM = new RegExp(
  `\\bexport\\s+(?:type\\s+)?(\\*(?:\\s*as\\s+${IDENTIFIER})?|\\{[^}]*\\})\\s*from\\s*(['"])([^'"\\r\\n]+)\\2`,
  'g'
)
const IMPORT_EQUALS = new RegExp(
  `\\bimport\\s+(${IDENTIFIER})\\s*=\\s*require\\s*\\(\\s*(['"])([^'"\\r\\n]+)\\2\\s*\\)`,
  'g'
)
const SIDE_EFFECT_IMPORT = /\bimport\s*(['"])([^'"\r\n]+)\1/g
const MODULE_CALL = /(?<![.\w$])(?:import|require)\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g
const LEADING_IDENTIFIER = new RegExp(`^(${IDENTIFIER})`)
const NAMESPACE_CLAUSE = new RegExp(`\\*\\s*as\\s+(${IDENTIFIER})`)

/**
 * Blank comments and template bodies, keeping offsets, so statement patterns only see code and plain
 * string literals; `blankStrings` also blanks those literals' contents for declaration lookups.
 */
export function maskNonCodeText(source: string, { blankStrings = false } = {}): string {
  const chars = source.split('')
  let index = 0
  const blank = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (chars[at] !== '\n' && chars[at] !== '\r') {
        chars[at] = ' '
      }
    }
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
    } else if (char === "'" || char === '"' || char === '`') {
      let at = index + 1
      while (at < source.length && source[at] !== char) {
        if (char !== '`' && source[at] === '\n') {
          break
        }
        at += source[at] === '\\' ? 2 : 1
      }
      if (char === '`' || blankStrings) {
        blank(index + 1, Math.min(at, source.length))
      }
      index = at + 1
    } else {
      index += 1
    }
  }
  return chars.join('')
}

function namedBindings(clause: string, clauseOffset: number): ImportBinding[] {
  const open = clause.indexOf('{')
  const close = clause.indexOf('}', open)
  if (open === -1 || close === -1) {
    return []
  }
  const bindings: ImportBinding[] = []
  let cursor = open + 1
  for (const part of clause.slice(open + 1, close).split(',')) {
    const partOffset = clauseOffset + cursor
    cursor += part.length + 1
    const match = new RegExp(
      `^(\\s*(?:type\\s+)?)(${IDENTIFIER})(?:(\\s+as\\s+)(${IDENTIFIER}))?\\s*$`
    ).exec(part)
    if (!match) {
      continue
    }
    const [, lead, name, asText, alias] = match
    // Why: an alias is the name callers use, but navigation follows the exported name.
    const offset = alias
      ? partOffset + lead.length + name.length + asText.length
      : partOffset + lead.length
    bindings.push({ local: alias ?? name, imported: name, offset })
  }
  return bindings
}

function importClauseBindings(clause: string, clauseOffset: number): ImportBinding[] {
  const bindings: ImportBinding[] = []
  const leading = LEADING_IDENTIFIER.exec(clause)
  if (leading && leading[1] !== 'type') {
    bindings.push({ local: leading[1], imported: 'default', offset: clauseOffset })
  }
  const namespace = NAMESPACE_CLAUSE.exec(clause)
  if (namespace) {
    const nameOffset = namespace.index + namespace[0].length - namespace[1].length
    bindings.push({ local: namespace[1], imported: '*', offset: clauseOffset + nameOffset })
  }
  return [...bindings, ...namedBindings(clause, clauseOffset)]
}

/** Import-like statements of a JS/TS source, ordered by position. */
export function scanImportStatements(source: string): ImportStatement[] {
  const masked = maskNonCodeText(source)
  // Why: a statement keyword blanked here sits inside a string literal, e.g. a code sample.
  const code = maskNonCodeText(source, { blankStrings: true })
  const statements: ImportStatement[] = []
  const covered: [number, number][] = []
  const add = (match: RegExpExecArray, specifierGroup: number, bindings: ImportBinding[]): void => {
    const specifier = match[specifierGroup]
    const specifierEnd = match.index + match[0].lastIndexOf(specifier) + specifier.length
    const start = match.index
    const end = match.index + match[0].length
    if (
      code[start] !== masked[start] ||
      covered.some(([from, to]) => start >= from && start < to)
    ) {
      return
    }
    covered.push([start, end])
    statements.push({
      start,
      end,
      specifier,
      specifierStart: specifierEnd - specifier.length,
      specifierEnd,
      bindings
    })
  }
  for (const match of masked.matchAll(IMPORT_FROM)) {
    const clauseOffset = match.index + match[0].indexOf(match[1], 'import'.length)
    add(match, 3, importClauseBindings(match[1], clauseOffset))
  }
  for (const match of masked.matchAll(EXPORT_FROM)) {
    const clauseOffset = match.index + match[0].indexOf(match[1], 'export'.length)
    const namespace = NAMESPACE_CLAUSE.exec(match[1])
    add(
      match,
      3,
      namespace
        ? [
            {
              local: namespace[1],
              imported: '*',
              offset: clauseOffset + namespace.index + namespace[0].length - namespace[1].length
            }
          ]
        : namedBindings(match[1], clauseOffset)
    )
  }
  for (const match of masked.matchAll(IMPORT_EQUALS)) {
    const offset = match.index + match[0].indexOf(match[1], 'import'.length)
    add(match, 3, [{ local: match[1], imported: '*', offset }])
  }
  for (const match of masked.matchAll(SIDE_EFFECT_IMPORT)) {
    add(match, 2, [])
  }
  for (const match of masked.matchAll(MODULE_CALL)) {
    add(match, 2, [])
  }
  return statements.sort((a, b) => a.start - b.start)
}

/**
 * Picks the import a definition request lands on: the module path under the cursor, or the
 * binding the language service resolved the cursor's name to.
 */
export function findImportNavigationRequest(
  statements: readonly ImportStatement[],
  cursorOffset: number,
  definitionOffsets: readonly number[]
): ImportNavigationRequest | null {
  for (const statement of statements) {
    // Why: quotes count as part of the path so clicking either edge still opens the module.
    if (cursorOffset >= statement.specifierStart - 1 && cursorOffset <= statement.specifierEnd) {
      return { specifier: statement.specifier, importedName: null }
    }
  }
  for (const offset of definitionOffsets) {
    for (const statement of statements) {
      if (offset < statement.start || offset >= statement.end) {
        continue
      }
      const binding = statement.bindings.find(
        (candidate) =>
          offset >= candidate.offset && offset < candidate.offset + candidate.local.length
      )
      if (binding) {
        return { specifier: statement.specifier, importedName: binding.imported }
      }
    }
  }
  return null
}
