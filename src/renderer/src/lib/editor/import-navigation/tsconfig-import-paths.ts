import { parse } from 'jsonc-parser'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
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
type ConfigSources = { include: string[] | null; files: string[] | null; configDir: string }

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
  let inheritedSources: ConfigSources | null = null
  if (depth < MAX_EXTENDS_DEPTH) {
    // Why: package-name bases (e.g. @tsconfig/node20) never define project aliases.
    for (const base of config.extends.filter(isPathLikeReference)) {
      const basePath = resolveModulePath(configDir, base.endsWith('.json') ? base : `${base}.json`)
      const parent = await loadConfigMappings(access, basePath, depth + 1)
      inheritedBaseUrl = parent?.baseUrl ?? inheritedBaseUrl
      inheritedPaths = parent?.paths ?? inheritedPaths
      inheritedSources =
        parent && (parent.sources.include || parent.sources.files)
          ? parent.sources
          : inheritedSources
    }
  }
  const ownSources = config.include || config.files
  return {
    baseUrl:
      config.baseUrl === undefined
        ? inheritedBaseUrl
        : resolveModulePath(configDir, config.baseUrl),
    paths: config.paths ? { entries: config.paths, originDir: configDir } : inheritedPaths,
    sources: ownSources
      ? { include: config.include ?? null, files: config.files ?? null, configDir }
      : (inheritedSources ?? { include: null, files: null, configDir }),
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

/** Whether a project's `include`/`files` (TypeScript's defaults when absent) can contain `filePath`. */
function sourcesCover({ include, files, configDir }: ConfigSources, filePath: string): boolean {
  if (files?.some((file) => resolveModulePath(configDir, file) === filePath)) {
    return true
  }
  const patterns = include ?? (files ? [] : ['**/*'])
  return patterns.some((pattern) => {
    const staticPrefix = pattern.split(/[*?{[]/)[0].replace(/[\\/]+$/, '')
    const base = staticPrefix ? resolveModulePath(configDir, staticPrefix) : configDir
    return getRelativePathInsideRoot(filePath, base) !== null
  })
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
  if (own) {
    return own
  }
  // Why: solution-style roots (Vite's tsconfig.json) keep aliases in referenced project configs.
  let fallback: ImportPathMappings | null = null
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
