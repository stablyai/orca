import { parse as parseJsonc } from 'jsonc-parser'
import { resolveRuntimePath } from '../file-access/cross-platform-path'

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.json'
]
// A specifier that already names a file is tried as written before any extension is appended.
const WRITTEN_FILE =
  /\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|vue|svelte|astro|mdx?|svg|png|jpe?g|gif|webp|html|graphql|gql|ya?ml|txt)$/i
// TypeScript sources are imported by their emitted name under NodeNext resolution.
const EMITTED_TO_SOURCE: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts']
}

export type ImportAliasConfig = {
  /** Absolute `baseUrl`, when one is in effect. */
  baseDirectory?: string
  paths?: Record<string, string[]>
  /** Directory of the config that declares `paths`; targets resolve there when no `baseUrl` is set. */
  pathsDirectory?: string
}

export function directoryOf(path: string): string {
  return resolveRuntimePath(path, '..')
}

export function isRelativeSpecifier(specifier: string): boolean {
  return /^\.{1,2}(?:\/|$)/.test(specifier)
}

/** Files a module path may name, in TypeScript's own resolution order. */
export function importFileCandidates(modulePath: string): string[] {
  const candidates: string[] = []
  const emitted = /\.[cm]?jsx?$/i.exec(modulePath)?.[0].toLowerCase()
  if (WRITTEN_FILE.test(modulePath)) {
    for (const source of (emitted && EMITTED_TO_SOURCE[emitted]) || []) {
      candidates.push(modulePath.slice(0, -emitted!.length) + source)
    }
    candidates.push(modulePath)
  }
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(modulePath + extension)
  }
  for (const extension of SOURCE_EXTENSIONS) {
    candidates.push(`${modulePath}/index${extension}`)
  }
  return candidates
}

/** Module paths a non-relative specifier maps to through `paths` and `baseUrl`; empty when neither applies. */
export function aliasModulePaths(specifier: string, config: ImportAliasConfig): string[] {
  let best: { prefix: string; exact: boolean; star: string; targets: string[] } | null = null
  for (const [pattern, targets] of Object.entries(config.paths ?? {})) {
    const starIndex = pattern.indexOf('*')
    const exact = starIndex === -1
    const prefix = exact ? pattern : pattern.slice(0, starIndex)
    const suffix = exact ? '' : pattern.slice(starIndex + 1)
    const matches = exact
      ? specifier === pattern
      : specifier.length >= prefix.length + suffix.length &&
        specifier.startsWith(prefix) &&
        specifier.endsWith(suffix)
    // TypeScript prefers an exact pattern, then the one with the longest literal prefix.
    if (
      matches &&
      (!best ||
        (exact && !best.exact) ||
        (exact === best.exact && prefix.length > best.prefix.length))
    ) {
      const star = specifier.slice(prefix.length, specifier.length - suffix.length)
      best = { prefix, exact, star, targets }
    }
  }
  const pathsBase = config.baseDirectory ?? config.pathsDirectory
  const mapped =
    best && pathsBase
      ? best.targets.map((target) => resolveRuntimePath(pathsBase, target.replace('*', best.star)))
      : []
  return config.baseDirectory
    ? [...mapped, resolveRuntimePath(config.baseDirectory, specifier)]
    : mapped
}

type ParsedCompilerConfig = {
  baseUrl?: string
  paths?: Record<string, string[]>
  extends: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the alias fields of a tsconfig/jsconfig, which allows comments and trailing commas. */
export function parseCompilerConfig(text: string): ParsedCompilerConfig | null {
  const parsed: unknown = parseJsonc(text, [], { allowTrailingComma: true })
  if (!isRecord(parsed)) {
    return null
  }
  const options = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : {}
  const paths: Record<string, string[]> = {}
  if (isRecord(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) {
        paths[pattern] = targets.filter((target): target is string => typeof target === 'string')
      }
    }
  }
  const inherited = Array.isArray(parsed.extends) ? parsed.extends : [parsed.extends]
  return {
    ...(typeof options.baseUrl === 'string' ? { baseUrl: options.baseUrl } : {}),
    ...(isRecord(options.paths) ? { paths } : {}),
    extends: inherited.filter((entry): entry is string => typeof entry === 'string')
  }
}
