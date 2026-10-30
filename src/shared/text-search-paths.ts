import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'

function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  if (isWindowsAbsolutePathLike(rootPath)) {
    return win32
  }
  return posix
}

export function normalizeRelativePath(path: string, rootPath?: string): string {
  const separators =
    rootPath !== undefined && !isWindowsAbsolutePathLike(rootPath) ? /\/+/g : /[\\/]+/g
  return path.replace(separators, '/').replace(/^\/+/, '')
}

export function relativeToSearchRoot(rootPath: string, absolutePath: string): string {
  return pathFlavor(rootPath).relative(rootPath, absolutePath)
}

export function resolveSearchResultPath(rootPath: string, reportedPath: string): string {
  const paths = pathFlavor(rootPath)
  return paths.isAbsolute(reportedPath) ? reportedPath : paths.resolve(rootPath, reportedPath)
}

export function joinSearchRoot(rootPath: string, relativePath: string): string {
  return pathFlavor(rootPath).join(rootPath, relativePath)
}
