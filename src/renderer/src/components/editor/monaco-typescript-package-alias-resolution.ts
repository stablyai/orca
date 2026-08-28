import { typescript as monacoTS } from 'monaco-editor'
import { joinPath } from '@/lib/path'
import { syncModel } from './monaco-typescript-model-sync'
import type { WorkspacePackageAlias } from './monaco-typescript-package-alias-path'
export {
  getWorkspacePackageAliasModelPath,
  type WorkspacePackageAlias
} from './monaco-typescript-package-alias-path'

const configuredWorkspaceCompilerOptions = new Set<string>()
const DEFAULT_PACKAGE_SOURCE_ENTRIES = [
  './src/index.ts',
  './src/index.tsx',
  './src/index.js',
  './index.ts',
  './index.tsx',
  './index.js'
] as const

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
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

function collectPackageExportPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === 'string') {
    paths.add(value)
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPackageExportPaths(item, paths)
    }
    return
  }
  for (const item of Object.values(value)) {
    collectPackageExportPaths(item, paths)
  }
}

function getPackageSourceEntryPaths(params: {
  rootPath: string
  directory: string
  packageJson: Record<string, unknown>
}): string[] {
  const relativeEntries = new Set<string>()
  for (const field of ['types', 'typings', 'module', 'main'] as const) {
    const value = params.packageJson[field]
    if (typeof value === 'string') {
      relativeEntries.add(value)
    }
  }
  collectPackageExportPaths(params.packageJson.exports, relativeEntries)
  for (const entry of DEFAULT_PACKAGE_SOURCE_ENTRIES) {
    relativeEntries.add(entry)
  }
  return Array.from(relativeEntries)
    .map((entry) =>
      joinPath(joinPath(params.rootPath, params.directory), normalizeRelativePath(entry))
    )
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
        const entryPaths = getPackageSourceEntryPaths({
          rootPath: params.rootPath,
          directory,
          packageJson: json
        })
        aliases.set(directory, { name, directory, entryPaths })
        syncModel(joinPath(params.rootPath, `node_modules/${name}/package.json`), result.content)
      } catch {
        // Best-effort package context: unreadable package.json files are ignored.
      }
    })
  )
  return aliases
}

export function configureWorkspacePackageResolution(params: {
  rootPath: string
  packageAliases: ReadonlyMap<string, WorkspacePackageAlias>
}): void {
  if (params.packageAliases.size === 0 || configuredWorkspaceCompilerOptions.has(params.rootPath)) {
    return
  }
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
  }
  const current = monacoTS.typescriptDefaults.getCompilerOptions()
  monacoTS.typescriptDefaults.setCompilerOptions({
    ...current,
    baseUrl: params.rootPath,
    paths: { ...current.paths, ...paths }
  })
  configuredWorkspaceCompilerOptions.add(params.rootPath)
}
