import { maskNonCodeText, scanImportStatements } from './import-statement-scan'

export type ExportLocation =
  | { kind: 'declaration'; offset: number }
  | { kind: 'reexport'; specifier: string; name: string }

const DECLARATION_KEYWORDS =
  '(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|interface|type|enum|namespace|module)'

function escapeIdentifier(name: string): string {
  return name.replace(/\$/g, '\\$')
}

type DeclarationOffsets = { first: number | null; moduleScope: number | null }

/** Where `name` sits in its first `prefix`-led declaration, and in the first one at module scope. */
function declarationOffsets(code: string, prefix: string, name: string): DeclarationOffsets {
  const pattern = new RegExp(
    `${prefix}${DECLARATION_KEYWORDS}\\s+(${escapeIdentifier(name)})(?![\\w$])`,
    'g'
  )
  let first: number | null = null
  let depth = 0
  let scanned = 0
  for (const match of code.matchAll(pattern)) {
    for (; scanned < match.index; scanned += 1) {
      // Why: regex literals stay unmasked, so a stray `}` must not sink module scope below zero.
      depth = Math.max(0, depth + (code[scanned] === '{' ? 1 : code[scanned] === '}' ? -1 : 0))
    }
    const offset = match.index + match[0].length - name.length
    first ??= offset
    if (depth === 0) {
      return { first, moduleScope: offset }
    }
  }
  return { first, moduleScope: null }
}

/** A module-level declaration; a same-named function, class or namespace member never counts. */
function moduleDeclaration(code: string, name: string): number | null {
  return declarationOffsets(code, '(?<![\\w$.])', name).moduleScope
}

/** The local that `export { … }` (without `from`) exports as `name`, and where the list names it. */
function exportListEntry(code: string, name: string): { local: string; offset: number } | null {
  for (const match of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g)) {
    let partOffset = match.index + match[0].indexOf('{') + 1
    for (const part of match[1].split(',')) {
      const entry = /^(\s*(?:type\s+)?)([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        part
      )
      if (entry && (entry[3] ?? entry[2]) === name) {
        return { local: entry[2], offset: partOffset + entry[1].length }
      }
      partOffset += part.length + 1
    }
  }
  return null
}

function forwardedLocal(
  code: string,
  statements: ReturnType<typeof scanImportStatements>,
  local: string
): ExportLocation | null {
  const declared = moduleDeclaration(code, local)
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
  let nestedExport: number | null = null
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
    const declared = declarationOffsets(code, '\\bexport\\s+(?:default\\s+)?', name)
    if (declared.moduleScope !== null) {
      return { kind: 'declaration', offset: declared.moduleScope }
    }
    nestedExport = declared.first
  }
  const listed = exportListEntry(code, name)
  if (listed) {
    // Why: a local export shadows `export *`, so a declaration the scan cannot see stays in this file.
    const listEntry: ExportLocation = { kind: 'declaration', offset: listed.offset }
    return forwardedLocal(code, statements, listed.local) ?? listEntry
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
  // Why: a namespace member loses to every module-level export above, but a regex literal's braces
  // can hide module scope, so an `export` the scan saw still beats none.
  return nestedExport === null ? null : { kind: 'declaration', offset: nestedExport }
}

/** Modules `source` forwards wholesale with `export * from`. */
export function starExportSpecifiers(source: string): string[] {
  const masked = maskNonCodeText(source)
  const code = maskNonCodeText(source, { blankStrings: true })
  return [...masked.matchAll(/\bexport\s+(?:type\s+)?\*\s*from\s*(['"])([^'"\r\n]+)\1/g)]
    .filter((match) => code[match.index] === masked[match.index])
    .map((match) => match[2])
}
