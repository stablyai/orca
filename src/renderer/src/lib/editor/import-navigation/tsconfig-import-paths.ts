import { parse } from 'jsonc-parser'
import { dirname, getRelativePathInsideRoot } from '@/lib/path'
import type { ImportNavigationFileAccess } from './import-navigation-file-access'
import {
  NO_IMPORT_PATH_MAPPINGS,
  isRelativeModuleSpecifier,
  resolveModulePath,
  type ImportPathMapping,
  type ImportPathMappings
} from './import-module-candidates'

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json']
const MAX_CONFIG_ANCESTORS = 32
const MAX_EXTENDS_DEPTH = 4
const MAX_REFERENCES = 8

type ConfigMappings = {
  baseUrl: string | null
  paths: ImportPathMapping[] | null
  references: string[]
}

type RawConfig = {
  extends: string[]
  baseUrl?: string
  paths?: Record<string, string[]>
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
  let inheritedPaths: ImportPathMapping[] | null = null
  if (depth < MAX_EXTENDS_DEPTH) {
    // Why: package-name bases (e.g. @tsconfig/node20) never define project aliases.
    for (const base of config.extends.filter(isPathLikeReference)) {
      const basePath = resolveModulePath(configDir, base.endsWith('.json') ? base : `${base}.json`)
      const parent = await loadConfigMappings(access, basePath, depth + 1)
      inheritedBaseUrl = parent?.baseUrl ?? inheritedBaseUrl
      inheritedPaths = parent?.paths ?? inheritedPaths
    }
  }
  const baseUrl =
    config.baseUrl === undefined ? inheritedBaseUrl : resolveModulePath(configDir, config.baseUrl)
  const paths = config.paths
    ? Object.entries(config.paths).map(([pattern, targets]) => ({
        pattern,
        targets,
        baseDir: baseUrl ?? configDir
      }))
    : inheritedPaths
  return {
    baseUrl,
    paths,
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
  return { baseUrl: config.baseUrl, paths: config.paths ?? [] }
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
  for (const reference of config.references.slice(0, MAX_REFERENCES)) {
    const referenced = await loadConfigMappings(access, reference, 0)
    const mappings = referenced ? toMappings(referenced) : null
    if (mappings) {
      return mappings
    }
  }
  return NO_IMPORT_PATH_MAPPINGS
}
