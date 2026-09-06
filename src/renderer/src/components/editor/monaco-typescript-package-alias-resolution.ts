import { typescript as monacoTS } from 'monaco-editor'
import { joinPath } from '@/lib/path'
import { syncModel } from './monaco-typescript-model-sync'
import type { WorkspacePackageAlias } from './monaco-typescript-package-alias-path'
export {
  getWorkspacePackageAliasModelPath,
  type WorkspacePackageAlias
} from './monaco-typescript-package-alias-path'

type WorkspaceCompilerConfig = {
  baseUrl: string
  paths: Record<string, string[]>
}

// Why: captured once, before any workspace ever applies its own baseUrl/paths, so switching
// workspaces can always derive from a clean base instead of merging onto whatever the
// previously active workspace left behind (monacoTS.typescriptDefaults is process-global).
const baseCompilerOptions = monacoTS.typescriptDefaults.getCompilerOptions()
const compilerConfigByRootPath = new Map<string, WorkspaceCompilerConfig>()
let activeRootPath: string | null = null
let activeConfig: WorkspaceCompilerConfig | undefined

const DEFAULT_PACKAGE_SOURCE_ENTRIES = [
  './src/index.ts',
  './src/index.tsx',
  './src/index.js',
  './index.ts',
  './index.tsx',
  './index.js'
] as const

function normalizeRelativePath(path: string): string {
  return path
    .replace(/[\\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

function tryParseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

// Why: an `exports` subpath key (e.g. "./runtime") doesn't necessarily match the shape of its
// target path (e.g. "./src/browser.ts"), so track each subpath's exact target alongside the
// flat set of all targets — condition keys ("import", "require", "types", ...) share the
// nearest enclosing subpath rather than introducing one, per the exports field spec.
function collectPackageExportEntries(
  value: unknown,
  subpath: string | null,
  allTargets: Set<string>,
  exportEntries: Map<string, string>
): void {
  if (typeof value === 'string') {
    allTargets.add(value)
    if (subpath !== null && !exportEntries.has(subpath)) {
      exportEntries.set(subpath, value)
    }
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPackageExportEntries(item, subpath, allTargets, exportEntries)
    }
    return
  }
  for (const [key, item] of Object.entries(value)) {
    collectPackageExportEntries(
      item,
      key.startsWith('.') ? key : subpath,
      allTargets,
      exportEntries
    )
  }
}

function getPackageSourceEntryPaths(params: {
  rootPath: string
  directory: string
  packageJson: Record<string, unknown>
}): { entryPaths: string[]; exportSubpaths: Record<string, string> } {
  const relativeEntries = new Set<string>()
  for (const field of ['types', 'typings', 'module', 'main'] as const) {
    const value = params.packageJson[field]
    if (typeof value === 'string') {
      relativeEntries.add(value)
    }
  }
  const exportTargets = new Set<string>()
  const exportEntries = new Map<string, string>()
  collectPackageExportEntries(params.packageJson.exports, null, exportTargets, exportEntries)
  for (const target of exportTargets) {
    relativeEntries.add(target)
  }
  for (const entry of DEFAULT_PACKAGE_SOURCE_ENTRIES) {
    relativeEntries.add(entry)
  }
  const packageDirectory = joinPath(params.rootPath, params.directory)
  const entryPaths = Array.from(relativeEntries).map((entry) =>
    joinPath(packageDirectory, normalizeRelativePath(entry))
  )
  const exportSubpaths: Record<string, string> = {}
  for (const [subpath, target] of exportEntries) {
    if (subpath === '.') {
      continue // the bare package specifier — already covered by paths[alias.name]
    }
    exportSubpaths[normalizeRelativePath(subpath)] = joinPath(
      packageDirectory,
      normalizeRelativePath(target)
    )
  }
  return { entryPaths, exportSubpaths }
}

export async function readWorkspacePackageAliases(params: {
  rootPath: string
  packageJsonPaths: readonly string[]
  connectionId?: string
}): Promise<Map<string, WorkspacePackageAlias>> {
  const aliases = new Map<string, WorkspacePackageAlias>()
  await Promise.all(
    params.packageJsonPaths.map(async (filePath) => {
      try {
        const result = await window.api.fs.readFile({
          filePath,
          connectionId: params.connectionId
        })
        if (result.isBinary) {
          return
        }
        const json = tryParseJsonObject(result.content)
        if (!json) {
          return
        }
        const name = typeof json?.name === 'string' ? json.name : null
        if (!name) {
          return
        }
        const relativePath = filePath.startsWith(params.rootPath)
          ? filePath.slice(params.rootPath.length).replace(/^[\\/]+/, '')
          : filePath
        const directory = relativePath.replace(/[\\/]package\.json$/, '').replace(/[\\/]+/g, '/')
        const { entryPaths, exportSubpaths } = getPackageSourceEntryPaths({
          rootPath: params.rootPath,
          directory,
          packageJson: json
        })
        aliases.set(directory, { name, directory, entryPaths, exportSubpaths })
        syncModel(joinPath(params.rootPath, `node_modules/${name}/package.json`), result.content)
      } catch {
        // Best-effort package context: unreadable package.json files are ignored.
      }
    })
  )
  return aliases
}

function computeWorkspaceCompilerConfig(params: {
  rootPath: string
  packageAliases: ReadonlyMap<string, WorkspacePackageAlias>
}): WorkspaceCompilerConfig {
  const paths: Record<string, string[]> = {}
  for (const alias of params.packageAliases.values()) {
    paths[alias.name] = alias.entryPaths
      .filter((entryPath) => entryPath.startsWith(params.rootPath))
      .map((entryPath) => normalizeRelativePath(entryPath.slice(params.rootPath.length)))
    const sourceRoots = new Set<string>()
    for (const entryPath of alias.entryPaths) {
      const relativeEntry = entryPath.startsWith(params.rootPath)
        ? normalizeRelativePath(entryPath.slice(params.rootPath.length))
        : normalizeRelativePath(entryPath)
      const sourceRootMatch = /^(.*\/src)\//.exec(relativeEntry)
      sourceRoots.add(sourceRootMatch?.[1] ?? alias.directory)
    }
    paths[`${alias.name}/*`] = Array.from(sourceRoots).map((sourceRoot) => `${sourceRoot}/*`)
    for (const [subpath, target] of Object.entries(alias.exportSubpaths ?? {})) {
      if (!target.startsWith(params.rootPath)) {
        continue
      }
      paths[`${alias.name}/${subpath}`] = [
        normalizeRelativePath(target.slice(params.rootPath.length))
      ]
    }
  }
  return { baseUrl: params.rootPath, paths }
}

// Why: Monaco's typescriptDefaults are process-global, so only one workspace's baseUrl/paths
// can be active at a time. Always replace from the captured base rather than merging onto the
// current options, so a previous workspace's aliases never leak into one with none (or
// different alias names).
export function applyWorkspaceCompilerOptions(rootPath: string): void {
  const config = compilerConfigByRootPath.get(rootPath)
  if (activeRootPath === rootPath && activeConfig === config) {
    return
  }
  activeRootPath = rootPath
  activeConfig = config
  monacoTS.typescriptDefaults.setCompilerOptions(
    config
      ? { ...baseCompilerOptions, baseUrl: config.baseUrl, paths: config.paths }
      : { ...baseCompilerOptions }
  )
}

export function cacheWorkspacePackageResolution(params: {
  rootPath: string
  packageAliases: ReadonlyMap<string, WorkspacePackageAlias>
}): void {
  if (params.packageAliases.size === 0) {
    return
  }
  compilerConfigByRootPath.set(params.rootPath, computeWorkspaceCompilerConfig(params))
  // Why: hydration is async — reapply immediately only if this workspace is still the one
  // being viewed, so a slow hydration for a workspace the user has since navigated away from
  // doesn't clobber whichever workspace's options are active now.
  if (activeRootPath === params.rootPath) {
    activeConfig = undefined
    applyWorkspaceCompilerOptions(params.rootPath)
  }
}
