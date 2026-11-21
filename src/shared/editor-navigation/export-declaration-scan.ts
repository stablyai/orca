import { findImportReferenceAt, IDENTIFIER_SOURCE, parseListElement } from './import-reference-scan'
import { blankComments } from './source-comment-blanking'

export type ExportDeclaration =
  | { kind: 'declaration'; offset: number }
  | { kind: 'reexport'; specifier: string; exportName: string }

const DECLARATION_KEYWORDS = 'function\\s*\\*?|class|const|let|var|type|interface|enum|namespace'
const NAME_END = '(?![\\p{ID_Continue}$])'
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}(?:\s*from\s*(['"])([^'"\n]+)\2)?/g
const STAR_REEXPORT = /\bexport\s*\*\s*from\s*(['"])([^'"\n]+)\1/g
const IS_IDENTIFIER = new RegExp(`^${IDENTIFIER_SOURCE}$`, 'u')

function escapeName(name: string): string {
  return name.replace(/[$]/g, '\\$&')
}

function declarationOffset(source: string, name: string, exported: boolean): number | null {
  const prefix = exported
    ? '\\bexport\\s+(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?'
    : '(?<![\\p{ID_Continue}$.])(?:async\\s+)?'
  const match = new RegExp(
    `${prefix}(?:${DECLARATION_KEYWORDS})\\s+(${escapeName(name)})${NAME_END}`,
    'u'
  ).exec(source)
  return match ? match.index + match[0].lastIndexOf(match[1]) : null
}

function listedExport(source: string, exportName: string): ExportDeclaration | null {
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const element of match[1].split(',')) {
      // An export element reads `local as exported`.
      const parsed = parseListElement(element)
      if (!parsed || parsed.alias !== exportName) {
        continue
      }
      const local = parsed.name
      if (match[3]) {
        return { kind: 'reexport', specifier: match[3], exportName: local }
      }
      const offset = declarationOffset(source, local, false)
      if (offset !== null) {
        return { kind: 'declaration', offset }
      }
      // The listed name is an import of this file, so the real declaration lives one module further.
      const binding = new RegExp(
        `\\bimport\\b[^;]*?(?<![\\p{ID_Continue}$])${escapeName(local)}${NAME_END}[^;]*?\\bfrom\\b`,
        'u'
      ).exec(source)
      const imported = binding
        ? findImportReferenceAt(source, binding.index + binding[0].lastIndexOf(local))
        : null
      return imported
        ? { kind: 'reexport', ...imported }
        : { kind: 'declaration', offset: match.index + match[0].indexOf(local) }
    }
  }
  return null
}

/** Locate where `exportName` (`default` for the default export) is declared, or which module it is re-exported from. */
export function findExportDeclaration(
  rawSource: string,
  exportName: string
): ExportDeclaration | null {
  if (exportName !== 'default' && !IS_IDENTIFIER.test(exportName)) {
    return null
  }
  const source = blankComments(rawSource)
  if (exportName === 'default') {
    const match = /\bexport\s+default\b/.exec(source)
    return match ? { kind: 'declaration', offset: match.index } : listedExport(source, 'default')
  }
  const offset = declarationOffset(source, exportName, true)
  return offset === null ? listedExport(source, exportName) : { kind: 'declaration', offset }
}

/** Modules whose whole surface this file re-exports; a name missing here may be declared there. */
export function findStarReexports(rawSource: string): string[] {
  return [...blankComments(rawSource).matchAll(STAR_REEXPORT)].map((match) => match[2])
}
