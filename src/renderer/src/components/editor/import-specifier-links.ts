import type { IRange } from 'monaco-editor'
import { dirname, joinPath } from '@/lib/path'
import {
  findJavaScriptNonCodeRanges,
  isOffsetInJavaScriptNonCodeRange
} from './javascript-non-code-ranges'
import type { TsconfigPathAliases } from './tsconfig-path-aliases'

export type ImportSpecifierLink = { range: IRange; specifier: string }

const IMPORT_LINK_LANGUAGE_IDS = new Set(['typescript', 'javascript'])

export function supportsImportSpecifierLinks(languageId: string): boolean {
  return IMPORT_LINK_LANGUAGE_IDS.has(languageId)
}

// `from '...'`, side-effect `import '...'`, dynamic `import('...')`, `require('...')`.
const SPECIFIER_PATTERN =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\r\n]+)\2/g

// Import/export clause up to `from '...'`; the negated class spans newlines so
// prettier-wrapped multi-line clauses still match, while quotes/semicolons/parens
// stop runaway matches across statements.
const CLAUSE_PATTERN =
  /\b(?:import|export)(\s+type\b)?([^'"`;()]{0,400}?)\bfrom\s*(['"])([^'"\r\n]+)\3/g

const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g
const CLAUSE_KEYWORDS = new Set(['as', 'type', 'default'])

function buildLineStarts(content: string): number[] {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      starts.push(index + 1)
    }
  }
  return starts
}

function offsetToRange(lineStarts: number[], startOffset: number, length: number): IRange {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= startOffset) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  const column = startOffset - lineStarts[low] + 1
  return {
    startLineNumber: low + 1,
    startColumn: column,
    endLineNumber: low + 1,
    endColumn: column + length
  }
}

export function getImportSpecifierLinks(content: string): ImportSpecifierLink[] {
  const lineStarts = buildLineStarts(content)
  const nonCodeRanges = findJavaScriptNonCodeRanges(content)
  const links: ImportSpecifierLink[] = []

  SPECIFIER_PATTERN.lastIndex = 0
  for (const match of content.matchAll(SPECIFIER_PATTERN)) {
    if (isOffsetInJavaScriptNonCodeRange(match.index, nonCodeRanges)) {
      continue
    }
    const specifier = match[3]
    const startOffset = match.index + match[1].length + 1
    links.push({ range: offsetToRange(lineStarts, startOffset, specifier.length), specifier })
  }

  CLAUSE_PATTERN.lastIndex = 0
  for (const match of content.matchAll(CLAUSE_PATTERN)) {
    if (isOffsetInJavaScriptNonCodeRange(match.index, nonCodeRanges)) {
      continue
    }
    const clause = match[2]
    const specifier = match[4]
    // 6 = length of both `import` and `export`.
    const clauseStart = match.index + 6 + (match[1]?.length ?? 0)
    if (isOffsetInJavaScriptNonCodeRange(clauseStart + clause.length, nonCodeRanges)) {
      continue
    }
    IDENTIFIER_PATTERN.lastIndex = 0
    for (const identifier of clause.matchAll(IDENTIFIER_PATTERN)) {
      if (
        CLAUSE_KEYWORDS.has(identifier[0]) ||
        isOffsetInJavaScriptNonCodeRange(clauseStart + identifier.index, nonCodeRanges)
      ) {
        continue
      }
      links.push({
        range: offsetToRange(lineStarts, clauseStart + identifier.index, identifier[0].length),
        specifier
      })
    }
  }

  return links
}

export function findImportSpecifierLinkAt(
  links: ImportSpecifierLink[],
  position: { lineNumber: number; column: number }
): ImportSpecifierLink | null {
  return (
    links.find(
      (link) =>
        link.range.startLineNumber === position.lineNumber &&
        position.column >= link.range.startColumn &&
        position.column <= link.range.endColumn
    ) ?? null
  )
}

function collapseDotSegments(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const isUnc = /^[\\/]{2}/.test(path)
  const isPosixAbsolute = !isUnc && path.startsWith('/')
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.')
  const collapsed: string[] = []
  for (const segment of segments) {
    const last = collapsed.at(-1)
    // Why: never pop past a drive root (`C:`) or a UNC host — `..` above the
    // root must not rewrite the prefix into a different filesystem location.
    if (segment === '..' && last !== undefined && last !== '..' && !/^[A-Za-z]:$/.test(last)) {
      if (!(isUnc && collapsed.length <= 2)) {
        collapsed.pop()
        continue
      }
    }
    collapsed.push(segment)
  }
  const prefix = isUnc ? separator + separator : isPosixAbsolute ? '/' : ''
  return prefix + collapsed.join(separator)
}

const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx'
]

// NodeNext-style specifiers reference emitted `.js` while the source is `.ts`.
const EMITTED_TO_SOURCE_EXTENSIONS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts']
}

const MAX_TARGET_CANDIDATES = 24

export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || /^\.\.?[\\/]/.test(specifier)
}

function matchAliasBases(
  specifier: string,
  worktreeRoot: string,
  aliases: TsconfigPathAliases
): string[] {
  const aliasRoot = aliases.baseUrl ? joinPath(worktreeRoot, aliases.baseUrl) : worktreeRoot
  const patterns = Object.keys(aliases.paths).sort((a, b) => {
    const aExact = a.includes('*') ? 1 : 0
    const bExact = b.includes('*') ? 1 : 0
    if (aExact !== bExact) {
      return aExact - bExact
    }
    return b.length - a.length
  })
  for (const pattern of patterns) {
    let wildcard: string | null = null
    const starIndex = pattern.indexOf('*')
    if (starIndex === -1) {
      if (specifier !== pattern) {
        continue
      }
    } else {
      const prefix = pattern.slice(0, starIndex)
      const suffix = pattern.slice(starIndex + 1)
      if (
        specifier.length < prefix.length + suffix.length ||
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix)
      ) {
        continue
      }
      wildcard = specifier.slice(prefix.length, specifier.length - suffix.length)
    }
    // Why: mirror TypeScript — only the first matching pattern's targets apply.
    return aliases.paths[pattern].map((target) =>
      joinPath(aliasRoot, wildcard === null ? target : target.replace('*', wildcard))
    )
  }
  return []
}

export function buildImportTargetCandidates(
  rawSpecifier: string,
  sourceFilePath: string,
  worktreeRoot: string | null,
  aliases: TsconfigPathAliases | null
): string[] {
  // Strip bundler suffixes like `?raw` before resolving against the filesystem.
  const specifier = rawSpecifier.replace(/[?#].*$/, '')
  if (!specifier) {
    return []
  }

  const bases: string[] = []
  if (isRelativeSpecifier(specifier)) {
    bases.push(joinPath(dirname(sourceFilePath), specifier))
  } else if (worktreeRoot) {
    bases.push(...matchAliasBases(specifier, worktreeRoot, aliases ?? { baseUrl: null, paths: {} }))
    if (bases.length === 0 && /^[@~]/.test(specifier)) {
      // Why: many repos define aliases in bundler config Orca cannot see, so fall
      // back to the common `@x/y` → `src/x/y` and root-relative conventions.
      const stripped = specifier.replace(/^[@~]\/?/, '')
      if (stripped) {
        bases.push(joinPath(worktreeRoot, joinPath('src', stripped)))
        bases.push(joinPath(worktreeRoot, stripped))
      }
    }
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (candidate: string): void => {
    const collapsed = collapseDotSegments(candidate)
    if (!seen.has(collapsed) && candidates.length < MAX_TARGET_CANDIDATES) {
      seen.add(collapsed)
      candidates.push(collapsed)
    }
  }

  for (const base of bases) {
    const emittedMatch = /\.(?:[mc]?js|jsx)$/.exec(base)
    if (emittedMatch) {
      push(base)
      for (const sourceExtension of EMITTED_TO_SOURCE_EXTENSIONS[emittedMatch[0]] ?? []) {
        push(base.slice(0, -emittedMatch[0].length) + sourceExtension)
      }
      continue
    }
    for (const suffix of RESOLUTION_SUFFIXES) {
      push(base + suffix)
    }
  }
  return candidates
}
