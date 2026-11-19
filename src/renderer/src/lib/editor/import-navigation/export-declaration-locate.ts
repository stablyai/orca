import { maskNonCodeText, scanImportStatements } from './import-statement-scan'

export type ExportLocation =
  | { kind: 'declaration'; offset: number }
  | { kind: 'reexport'; specifier: string; name: string }

const DECLARATION_KEYWORDS =
  '(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum|namespace|module)'

function escapeIdentifier(name: string): string {
  return name.replace(/\$/g, '\\$')
}

function exportedDeclaration(masked: string, name: string): number | null {
  const match = new RegExp(
    `\\bexport\\s+(?:default\\s+)?${DECLARATION_KEYWORDS}\\s+(${escapeIdentifier(name)})(?![\\w$])`
  ).exec(masked)
  return match ? match.index + match[0].length - name.length : null
}

function localDeclaration(masked: string, name: string): number | null {
  const match = new RegExp(
    `(?<![\\w$.])${DECLARATION_KEYWORDS}\\s+(${escapeIdentifier(name)})(?![\\w$])`
  ).exec(masked)
  return match ? match.index + match[0].length - name.length : null
}

/** Local names listed in `export { … }` (without `from`) under the exported `name`. */
function exportListSource(masked: string, name: string): string | null {
  for (const match of masked.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g)) {
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

/** Where `source` declares its export `name`, or the module it re-exports that name from. */
export function locateExportedName(source: string, name: string): ExportLocation | null {
  const masked = maskNonCodeText(source)
  if (name === 'default') {
    const defaultExport = /\bexport\s+default\b/.exec(masked)
    if (defaultExport) {
      const named = new RegExp(`^\\s*${DECLARATION_KEYWORDS}\\s+([A-Za-z_$][\\w$]*)`).exec(
        masked.slice(defaultExport.index + defaultExport[0].length)
      )
      return {
        kind: 'declaration',
        offset: named
          ? defaultExport.index + defaultExport[0].length + named[0].length - named[1].length
          : defaultExport.index
      }
    }
  } else {
    const declared = exportedDeclaration(masked, name)
    if (declared !== null) {
      return { kind: 'declaration', offset: declared }
    }
  }
  const statements = scanImportStatements(source)
  const listed = exportListSource(masked, name)
  if (listed) {
    const local = localDeclaration(masked, listed)
    if (local !== null) {
      return { kind: 'declaration', offset: local }
    }
    // Why: `import { a } from './a'; export { a }` forwards the import rather than declaring it.
    for (const statement of statements) {
      const binding = statement.bindings.find((candidate) => candidate.local === listed)
      if (binding && masked.slice(statement.start, statement.start + 6) === 'import') {
        return { kind: 'reexport', specifier: statement.specifier, name: binding.imported }
      }
    }
  }
  for (const statement of statements) {
    if (masked.slice(statement.start, statement.start + 6) !== 'export') {
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
  return [...masked.matchAll(/\bexport\s+(?:type\s+)?\*\s*from\s*(['"])([^'"\r\n]+)\1/g)].map(
    (match) => match[2]
  )
}
