import { posix, win32 } from 'node:path'

function pathFlavor(rootPath: string): typeof posix | typeof win32 {
  if (/^[a-zA-Z]:[\\/]/.test(rootPath) || rootPath.startsWith('\\\\')) {
    return win32
  }
  return posix
}

export function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

export function relativeToSearchRoot(rootPath: string, absolutePath: string): string {
  return pathFlavor(rootPath).relative(rootPath, absolutePath)
}

export function joinSearchRoot(rootPath: string, relativePath: string): string {
  return pathFlavor(rootPath).join(rootPath, relativePath)
}
