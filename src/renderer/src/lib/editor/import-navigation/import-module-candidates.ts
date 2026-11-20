import { resolveRuntimePath } from '../../../../../shared/file-access/cross-platform-path'

export type ImportPathMapping = {
  pattern: string
  targets: string[]
  /** Directory the targets are relative to. */
  baseDir: string
}

export type ImportPathMappings = {
  baseUrl: string | null
  paths: ImportPathMapping[]
}

export const NO_IMPORT_PATH_MAPPINGS: ImportPathMappings = { baseUrl: null, paths: [] }

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
// TypeScript's ESM convention imports the emitted extension while the source keeps its own.
const SOURCE_EXTENSIONS_FOR_EMITTED: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts']
}

export function isRelativeModuleSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  )
}

/** Resolves `relative` against `baseDir`, keeping backslashes when the base path uses them. */
export function resolveModulePath(baseDir: string, relative: string): string {
  const resolved = resolveRuntimePath(baseDir, relative)
  if (!baseDir.includes('\\') || baseDir.includes('/')) {
    return resolved
  }
  return resolved.startsWith('//')
    ? `\\\\${resolved.slice(2).replace(/\//g, '\\')}`
    : resolved.replace(/\//g, '\\')
}

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  if (name.endsWith('.d.ts')) {
    return '.d.ts'
  }
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/** Files a module path can name, most specific first. */
export function moduleFileCandidates(modulePath: string): string[] {
  const extension = extensionOf(modulePath)
  const candidates: string[] = []
  const sourceExtensions = SOURCE_EXTENSIONS_FOR_EMITTED[extension]
  if (sourceExtensions) {
    const stem = modulePath.slice(0, -extension.length)
    candidates.push(...sourceExtensions.map((source) => stem + source))
  }
  // Why: a bare directory path also "exists", so only a named extension may match as-is.
  if (extension) {
    candidates.push(modulePath)
  }
  candidates.push(...SCRIPT_EXTENSIONS.map((suffix) => modulePath + suffix))
  const indexBase = resolveModulePath(modulePath, 'index')
  candidates.push(...SCRIPT_EXTENSIONS.map((suffix) => indexBase + suffix))
  return candidates
}

function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) {
    return pattern === specifier ? '' : null
  }
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (
    specifier.length < prefix.length + suffix.length ||
    !specifier.startsWith(prefix) ||
    !specifier.endsWith(suffix)
  ) {
    return null
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function patternPriority(pattern: string): number {
  const star = pattern.indexOf('*')
  return star === -1 ? Number.MAX_SAFE_INTEGER : star
}

/** Module paths a bare specifier maps to through `paths`, then `baseUrl`, in TypeScript's order. */
export function mappedModulePaths(specifier: string, mappings: ImportPathMappings): string[] {
  // Why: TypeScript tries only the best pattern (exact, else longest prefix), then `baseUrl`.
  let best: { mapping: ImportPathMapping; captured: string } | null = null
  for (const mapping of mappings.paths) {
    const captured = matchPattern(mapping.pattern, specifier)
    if (
      captured !== null &&
      (!best || patternPriority(mapping.pattern) > patternPriority(best.mapping.pattern))
    ) {
      best = { mapping, captured }
    }
  }
  const paths = best
    ? best.mapping.targets.map((target) =>
        resolveModulePath(best.mapping.baseDir, target.replace('*', best.captured))
      )
    : []
  if (mappings.baseUrl) {
    paths.push(resolveModulePath(mappings.baseUrl, specifier))
  }
  return paths
}
