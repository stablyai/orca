import { joinPath } from '@/lib/path'
import {
  isTypeScriptWorkspaceFilePath,
  TYPESCRIPT_WORKSPACE_MODEL_EXCLUDED_PATH_PARTS
} from './monaco-typescript-workspace-model-policy'
import { syncModel } from './monaco-typescript-model-sync'
import {
  configureWorkspacePackageResolution,
  getWorkspacePackageAliasModelPath,
  readWorkspacePackageAliases,
  type WorkspacePackageAlias
} from './monaco-typescript-package-alias-resolution'

const MAX_WORKSPACE_MODELS = 350
const MAX_PACKAGE_GRAPH_MODELS = 160
const READ_CONCURRENCY = 8
const SOURCE_EXTENSION_CANDIDATES = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
] as const

function getDirectoryPath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+/g, '/')
  return normalized.slice(0, normalized.lastIndexOf('/'))
}

function hasTypeScriptWorkspaceExtension(filePath: string): boolean {
  return /\.(?:[cm]?[tj]sx?|d\.ts)$/i.test(filePath)
}

function getImportSpecifierModelPaths(params: {
  rootPath: string
  filePath: string
  content: string
}): string[] {
  const paths: string[] = []
  const directoryPath = getDirectoryPath(params.filePath)
  const specifierPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
  for (const match of params.content.matchAll(specifierPattern)) {
    const specifier = match[1]
    if (!specifier?.startsWith('.')) {
      continue
    }
    const basePath = joinPath(directoryPath, specifier)
    if (hasTypeScriptWorkspaceExtension(basePath)) {
      paths.push(basePath)
      continue
    }
    for (const extension of SOURCE_EXTENSION_CANDIDATES) {
      paths.push(`${basePath}${extension}`)
    }
    for (const extension of SOURCE_EXTENSION_CANDIDATES.slice(1)) {
      paths.push(joinPath(basePath, `index${extension}`))
    }
  }
  return paths.filter((filePath) => filePath.startsWith(params.rootPath))
}

async function readFirstSourceCandidate(params: {
  filePaths: readonly string[]
  connectionId?: string
}): Promise<{ filePath: string; content: string } | null> {
  for (const filePath of params.filePaths) {
    try {
      if (
        !(await window.api.fs.pathExists({
          filePath,
          connectionId: params.connectionId
        }))
      ) {
        continue
      }
      const result = await window.api.fs.readFile({
        filePath,
        connectionId: params.connectionId
      })
      if (!result.isBinary) {
        return { filePath, content: result.content }
      }
    } catch {
      // Try the next TypeScript/JavaScript resolution candidate.
    }
  }
  return null
}

async function hydrateWorkspacePackageGraphs(params: {
  rootPath: string
  packageAliases: ReadonlyMap<string, WorkspacePackageAlias>
  connectionId?: string
}): Promise<void> {
  const queue = Array.from(params.packageAliases.values()).flatMap((alias) => alias.entryPaths)
  const visited = new Set<string>()
  let hydratedCount = 0

  while (queue.length > 0 && hydratedCount < MAX_PACKAGE_GRAPH_MODELS) {
    const queuedPath = queue.shift()
    if (!queuedPath || visited.has(queuedPath)) {
      continue
    }
    visited.add(queuedPath)
    const source = await readFirstSourceCandidate({
      filePaths: [queuedPath],
      connectionId: params.connectionId
    })
    if (!source) {
      continue
    }
    hydratedCount += 1
    syncModel(source.filePath, source.content)
    const relativePath = source.filePath.startsWith(params.rootPath)
      ? source.filePath.slice(params.rootPath.length).replace(/^[\\/]+/, '')
      : source.filePath
    const aliasModelPath = getWorkspacePackageAliasModelPath({
      rootPath: params.rootPath,
      relativePath,
      packageAliases: params.packageAliases
    })
    if (aliasModelPath) {
      syncModel(aliasModelPath, source.content)
    }
    for (const dependencyPath of getImportSpecifierModelPaths({
      rootPath: params.rootPath,
      filePath: source.filePath,
      content: source.content
    })) {
      if (!visited.has(dependencyPath)) {
        queue.push(dependencyPath)
      }
    }
  }
}

export async function readWorkspaceModels(params: {
  rootPath: string
  connectionId?: string
}): Promise<void> {
  const listedPaths = await window.api.fs.listFiles({
    rootPath: params.rootPath,
    connectionId: params.connectionId,
    excludePaths: Array.from(TYPESCRIPT_WORKSPACE_MODEL_EXCLUDED_PATH_PARTS),
    maxResults: MAX_WORKSPACE_MODELS * 4
  })
  const modelPaths = listedPaths
    .map((path) => (path.startsWith(params.rootPath) ? path : joinPath(params.rootPath, path)))
    .filter(isTypeScriptWorkspaceFilePath)
    .slice(0, MAX_WORKSPACE_MODELS)
  const packageJsonPaths = listedPaths
    .map((path) => (path.startsWith(params.rootPath) ? path : joinPath(params.rootPath, path)))
    .filter((path) => /(?:^|[\\/])package\.json$/.test(path))
  const packageAliases = await readWorkspacePackageAliases({
    rootPath: params.rootPath,
    packageJsonPaths,
    connectionId: params.connectionId
  })
  configureWorkspacePackageResolution({ rootPath: params.rootPath, packageAliases })
  await hydrateWorkspacePackageGraphs({
    rootPath: params.rootPath,
    packageAliases,
    connectionId: params.connectionId
  })

  for (let index = 0; index < modelPaths.length; index += READ_CONCURRENCY) {
    await Promise.all(
      modelPaths.slice(index, index + READ_CONCURRENCY).map(async (filePath) => {
        try {
          const result = await window.api.fs.readFile({
            filePath,
            connectionId: params.connectionId
          })
          if (!result.isBinary) {
            syncModel(filePath, result.content)
            const relativePath = filePath.startsWith(params.rootPath)
              ? filePath.slice(params.rootPath.length).replace(/^[\\/]+/, '')
              : filePath
            const aliasModelPath = getWorkspacePackageAliasModelPath({
              rootPath: params.rootPath,
              relativePath,
              packageAliases
            })
            if (aliasModelPath) {
              syncModel(aliasModelPath, result.content)
            }
          }
        } catch {
          // Best-effort project context: unreadable files should not break the editor.
        }
      })
    )
  }
}
