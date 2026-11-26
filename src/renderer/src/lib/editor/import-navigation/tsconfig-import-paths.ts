import { parse } from 'jsonc-parser'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import { isCaseInsensitiveRuntimeRoot } from '../../../../../shared/file-access/cross-platform-path'
import { escapeRegex } from '../../../../../shared/text/regex-escaping'
import type { ImportNavigationFileAccess } from './import-navigation-file-access'
import {
  NO_IMPORT_PATH_MAPPINGS,
  isRelativeModuleSpecifier,
  resolveModulePath,
  type ImportPathMappings
} from './import-module-candidates'

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json']
const MAX_CONFIG_ANCESTORS = 32
const MAX_EXTENDS_DEPTH = 4
const MAX_REFERENCES = 8

type ConfigPaths = { entries: Record<string, string[]>; originDir: string }
type ConfigSpecs = { specs: string[]; originDir: string }
type ConfigSources = {
  include: ConfigSpecs | null
  exclude: ConfigSpecs | null
  files: ConfigSpecs | null
  configDir: string
}

type ConfigMappings = {
  baseUrl: string | null
  paths: ConfigPaths | null
  sources: ConfigSources
  references: string[]
}

type RawConfig = {
  extends: string[]
  baseUrl?: string
  paths?: Record<string, string[]>
  include?: string[]
  exclude?: string[]
  files?: string[]
  references: string[]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseConfig(text: string): RawConfig | null {
  const config: unknown = parse(text, [], { allowTrailingComma: true })
  if (!isRecord(config)) {
    return null
  }
  const options = isRecord(config.compilerOptions) ? config.compilerOptions : {}
  const paths = isRecord(options.paths)
    ? Object.fromEntries(
        Object.entries(options.paths).map(([pattern, targets]) => [pattern, stringArray(targets)])
      )
    : undefined
  const references: unknown[] = Array.isArray(config.references) ? config.references : []
  return {
    extends: typeof config.extends === 'string' ? [config.extends] : stringArray(config.extends),
    baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : undefined,
    paths,
    include: Array.isArray(config.include) ? stringArray(config.include) : undefined,
    exclude: Array.isArray(config.exclude) ? stringArray(config.exclude) : undefined,
    files: Array.isArray(config.files) ? stringArray(config.files) : undefined,
    references: references.flatMap((reference) =>
      isRecord(reference) && typeof reference.path === 'string' ? [reference.path] : []
    )
  }
}

function isPathLikeReference(reference: string): boolean {
  return (
    isRelativeModuleSpecifier(reference) ||
    reference.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(reference)
  )
}

async function loadConfigMappings(
  access: ImportNavigationFileAccess,
  configPath: string,
  depth: number
): Promise<ConfigMappings | null> {
  const text = await access.readText(configPath)
  const config = text === null ? null : parseConfig(text)
  if (!config) {
    return null
  }
  const configDir = dirname(configPath)
  let inheritedBaseUrl: string | null = null
  let inheritedPaths: ConfigPaths | null = null
  let inheritedInclude: ConfigSpecs | null = null
  let inheritedExclude: ConfigSpecs | null = null
  let inheritedFiles: ConfigSpecs | null = null
  if (depth < MAX_EXTENDS_DEPTH) {
    // Why: package-name bases (e.g. @tsconfig/node20) never define project aliases.
    for (const base of config.extends.filter(isPathLikeReference)) {
      const basePath = resolveModulePath(configDir, base.endsWith('.json') ? base : `${base}.json`)
      const parent = await loadConfigMappings(access, basePath, depth + 1)
      inheritedBaseUrl = parent?.baseUrl ?? inheritedBaseUrl
      inheritedPaths = parent?.paths ?? inheritedPaths
      inheritedInclude = parent?.sources.include ?? inheritedInclude
      inheritedExclude = parent?.sources.exclude ?? inheritedExclude
      inheritedFiles = parent?.sources.files ?? inheritedFiles
    }
  }
  // Why: TypeScript inherits `include`, `exclude` and `files` one by one, each relative to its config.
  const ownSpecs = (specs: string[] | undefined): ConfigSpecs | null =>
    specs ? { specs, originDir: configDir } : null
  return {
    baseUrl:
      config.baseUrl === undefined
        ? inheritedBaseUrl
        : resolveModulePath(configDir, config.baseUrl),
    paths: config.paths ? { entries: config.paths, originDir: configDir } : inheritedPaths,
    sources: {
      include: ownSpecs(config.include) ?? inheritedInclude,
      exclude: ownSpecs(config.exclude) ?? inheritedExclude,
      files: ownSpecs(config.files) ?? inheritedFiles,
      configDir
    },
    references: config.references.map((reference) => {
      const referencePath = resolveModulePath(configDir, reference)
      return referencePath.endsWith('.json')
        ? referencePath
        : resolveModulePath(referencePath, 'tsconfig.json')
    })
  }
}

function configDirectoriesUpTo(filePath: string, rootPath: string): string[] {
  const directories: string[] = []
  let directory = dirname(filePath)
  while (directories.length < MAX_CONFIG_ANCESTORS) {
    if (getRelativePathInsideRoot(directory, rootPath) === null) {
      break
    }
    directories.push(directory)
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  return directories
}

function toMappings(config: ConfigMappings): ImportPathMappings | null {
  if (!config.paths && !config.baseUrl) {
    return null
  }
  const paths = config.paths
  // Why: TypeScript resolves `paths`, inherited ones included, against the effective `baseUrl`.
  const baseDir = config.baseUrl ?? paths?.originDir ?? ''
  return {
    baseUrl: config.baseUrl,
    paths: paths
      ? Object.entries(paths.entries).map(([pattern, targets]) => ({ pattern, targets, baseDir }))
      : []
  }
}

type SpecUsage = 'include' | 'exclude'

/** TypeScript's wildcards: `**` spans directories, while `*` and `?` stay within one segment. */
function wildcardSegmentsPattern(
  segments: string[],
  usage: SpecUsage,
  ignoreCase: boolean
): RegExp {
  const source = segments.map((segment, index) => {
    if (segment === '**') {
      return '(?:[^/]+/)*'
    }
    const literal = segment
      .split(/([*?])/)
      .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRegex(part)))
      .join('')
    return index < segments.length - 1 ? `${literal}/` : literal
  })
  // Why: an `exclude` entry also drops everything beneath the path it matches.
  const pattern = `^${source.join('')}${usage === 'exclude' ? '(?:$|/)' : '$'}`
  return new RegExp(pattern, ignoreCase ? 'i' : '')
}

/** Whether an `include` or `exclude` entry, already resolved against its config, names `filePath`. */
function specMatches(resolvedSpec: string, filePath: string, usage: SpecUsage): boolean {
  const trimmed = usage === 'exclude' ? resolvedSpec.replace(/[\\/]\*\*$/, '') : resolvedSpec
  const lastSegment = trimmed.slice(
    Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1
  )
  // Why: TypeScript reads a last segment without `.`, `*` or `?` as a directory (`src` → `src/**/*`).
  const spec = /[.*?]/.test(lastSegment) ? trimmed : `${trimmed}/**/*`
  const wildcardAt = spec.search(/[^\\/]*[*?]/)
  if (wildcardAt === -1) {
    const relative = getRelativePathInsideRoot(filePath, spec)
    return usage === 'exclude' ? relative !== null : relative === ''
  }
  const relative = getRelativePathInsideRoot(filePath, spec.slice(0, wildcardAt))
  const segments = spec.slice(wildcardAt).split(/[\\/]+/)
  // Why: TypeScript applies the file system's case policy to wildcards too, not only the prefix.
  const ignoreCase = isCaseInsensitiveRuntimeRoot(filePath)
  return relative !== null && wildcardSegmentsPattern(segments, usage, ignoreCase).test(relative)
}

function specsMatch(specs: ConfigSpecs | null, filePath: string, usage: SpecUsage): boolean {
  return (
    specs?.specs.some((spec) =>
      specMatches(resolveModulePath(specs.originDir, spec), filePath, usage)
    ) ?? false
  )
}

/** Whether a project owns `filePath`: listed in `files`, or matched by `include` and not `exclude`. */
function sourcesCover(
  { include, exclude, files, configDir }: ConfigSources,
  filePath: string
): boolean {
  const listed = files?.specs.some(
    (file) => getRelativePathInsideRoot(filePath, resolveModulePath(files.originDir, file)) === ''
  )
  if (listed) {
    return true
  }
  // Why: with neither `files` nor `include` set, TypeScript includes everything under the config.
  const includes = include ?? (files ? null : { specs: ['**/*'], originDir: configDir })
  return specsMatch(includes, filePath, 'include') && !specsMatch(exclude, filePath, 'exclude')
}

/** Alias rules from the nearest tsconfig/jsconfig at or above `filePath`, inside `rootPath`. */
export async function loadImportPathMappings(
  access: ImportNavigationFileAccess,
  filePath: string,
  rootPath: string
): Promise<ImportPathMappings> {
  const candidates = configDirectoriesUpTo(filePath, rootPath).flatMap((directory) =>
    CONFIG_FILE_NAMES.map((name) => resolveModulePath(directory, name))
  )
  if (candidates.length === 0) {
    return NO_IMPORT_PATH_MAPPINGS
  }
  const exists = await access.pathsExist(candidates)
  const nearest = candidates.find((_, index) => exists[index])
  const config = nearest ? await loadConfigMappings(access, nearest, 0) : null
  if (!config) {
    return NO_IMPORT_PATH_MAPPINGS
  }
  const own = toMappings(config)
  if (own && (config.references.length === 0 || sourcesCover(config.sources, filePath))) {
    return own
  }
  // Why: a solution-style root (Vite's tsconfig.json) owns no sources; the referenced project that
  // includes the file supplies its aliases, even when the root sets a `baseUrl` of its own.
  let fallback = own
  for (const reference of config.references.slice(0, MAX_REFERENCES)) {
    const referenced = await loadConfigMappings(access, reference, 0)
    const mappings = referenced ? toMappings(referenced) : null
    if (referenced && mappings && sourcesCover(referenced.sources, filePath)) {
      return mappings
    }
    fallback ??= mappings
  }
  return fallback ?? NO_IMPORT_PATH_MAPPINGS
}
