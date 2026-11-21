import { maskNonCodeText, scanImportStatements } from './import-statement-scan'

export type ExportLocation =
  | { kind: 'declaration'; offset: number }
  | { kind: 'reexport'; specifier: string; name: string }

const DECLARATION_KEYWORDS =
  '(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum|namespace|module)'

function escapeIdentifier(name: string): string {
  return name.replace(/\$/g, '\\$')
}

function exportedDeclaration(code: string, name: string): number | null {
  const match = new RegExp(
    `\\bexport\\s+(?:default\\s+)?${DECLARATION_KEYWORDS}\\s+(${escapeIdentifier(name)})(?![\\w$])`
  ).exec(code)
  return match ? match.index + match[0].length - name.length : null
}

/** Prefers a module-level declaration over a same-named one nested in a function or class body. */
function localDeclaration(code: string, name: string): number | null {
  const pattern = new RegExp(
    `(?<![\\w$.])${DECLARATION_KEYWORDS}\\s+(${escapeIdentifier(name)})(?![\\w$])`,
    'g'
  )
  let first: number | null = null
  let depth = 0
  let scanned = 0
  for (const match of code.matchAll(pattern)) {
    for (; scanned < match.index; scanned += 1) {
      depth += code[scanned] === '{' ? 1 : code[scanned] === '}' ? -1 : 0
    }
    const offset = match.index + match[0].length - name.length
    if (depth === 0) {
      return offset
    }
    first ??= offset
  }
  return first
}

/** Local names listed in `export { … }` (without `from`) under the exported `name`. */
function exportListSource(code: string, name: string): string | null {
  for (const match of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const part of match[1].split(',')) {
      const entry = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        part
      )
      if (entry && (entry[2] ?? entry[1]) === name) {
        return entry[1]
      }
    }
  }
  return null
}

function forwardedLocal(
  code: string,
  statements: ReturnType<typeof scanImportStatements>,
  local: string
): ExportLocation | null {
  const declared = localDeclaration(code, local)
  if (declared !== null) {
    return { kind: 'declaration', offset: declared }
  }
  // Why: `import { a } from './a'; export { a }` forwards the import rather than declaring it.
  for (const statement of statements) {
    const binding = statement.bindings.find((candidate) => candidate.local === local)
    if (binding && code.slice(statement.start, statement.start + 6) === 'import') {
      return { kind: 'reexport', specifier: statement.specifier, name: binding.imported }
    }
  }
  return null
}

/** Where `source` declares its export `name`, or the module it re-exports that name from. */
export function locateExportedName(source: string, name: string): ExportLocation | null {
  const code = maskNonCodeText(source, { blankStrings: true })
  const statements = scanImportStatements(source)
  if (name === 'default') {
    const defaultExport = /\bexport\s+default\b/.exec(code)
    if (defaultExport) {
      const afterDefault = defaultExport.index + defaultExport[0].length
      const named = new RegExp(`^\\s*${DECLARATION_KEYWORDS}\\s+([A-Za-z_$][\\w$]*)`).exec(
        code.slice(afterDefault)
      )
      if (named) {
        return { kind: 'declaration', offset: afterDefault + named[0].length - named[1].length }
      }
      // Why: `export default Button` names a binding declared or imported elsewhere in the file.
      const identifier = /^\s*([A-Za-z_$][\w$]*)\s*(?:;|\r?\n|$)/.exec(code.slice(afterDefault))
      const forwarded = identifier ? forwardedLocal(code, statements, identifier[1]) : null
      return forwarded ?? { kind: 'declaration', offset: defaultExport.index }
    }
  } else {
    const declared = exportedDeclaration(code, name)
    if (declared !== null) {
      return { kind: 'declaration', offset: declared }
    }
  }
  const listed = exportListSource(code, name)
  const forwarded = listed ? forwardedLocal(code, statements, listed) : null
  if (forwarded) {
    return forwarded
  }
  for (const statement of statements) {
    if (code.slice(statement.start, statement.start + 6) !== 'export') {
      continue
    }
    const binding = statement.bindings.find((candidate) => candidate.local === name)
    if (binding) {
      return { kind: 'reexport', specifier: statement.specifier, name: binding.imported }
    }
  }
  return null
}

/** Modules `source` forwards wholesale with `export * from`. */
export function starExportSpecifiers(source: string): string[] {
  const masked = maskNonCodeText(source)
  const code = maskNonCodeText(source, { blankStrings: true })
  return [...masked.matchAll(/\bexport\s+(?:type\s+)?\*\s*from\s*(['"])([^'"\r\n]+)\1/g)]
    .filter((match) => code[match.index] === masked[match.index])
    .map((match) => match[2])
}
