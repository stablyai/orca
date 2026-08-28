import { joinPath } from '@/lib/path'

export type WorkspacePackageAlias = {
  name: string
  directory: string
  entryPaths: string[]
}

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function getRelativePathInsideDirectory(relativePath: string, directory: string): string | null {
  const normalizedPath = normalizeRelativePath(relativePath)
  const normalizedDirectory = normalizeRelativePath(directory)
  if (normalizedPath === normalizedDirectory) {
    return ''
  }
  const prefix = `${normalizedDirectory}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
}

export function getWorkspacePackageAliasModelPath(params: {
  rootPath: string
  relativePath: string
  packageAliases: ReadonlyMap<string, WorkspacePackageAlias>
}): string | null {
  const alias = Array.from(params.packageAliases.values())
    .filter(
      (candidate) => getRelativePathInsideDirectory(params.relativePath, candidate.directory) !== null
    )
    .sort((left, right) => right.directory.length - left.directory.length)[0]
  if (!alias) {
    return null
  }
  const suffix = getRelativePathInsideDirectory(params.relativePath, alias.directory)
  if (!suffix) {
    return null
  }
  return joinPath(params.rootPath, `node_modules/${alias.name}/${suffix}`)
}
