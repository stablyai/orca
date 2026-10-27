import { joinPath, dirname, normalizeRelativePath } from '@/lib/path'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'

export function normalizeExplorerAbsolutePath(path: string): string {
  return path === '/' || /^[A-Za-z]:[\\/]$/.test(path)
    ? path
    : path.replace(isWindowsAbsolutePathLike(path) ? /[\\/]+$/ : /\/+$/, '')
}

export function getExternalFileChangeRelativePath(
  worktreePath: string,
  absolutePath: string,
  isDirectory: boolean | undefined
): string | null {
  if (isDirectory === true) {
    return null
  }

  const relativePath = relativePathInsideRoot(worktreePath, absolutePath)
  if (relativePath === null || relativePath === '') {
    return null
  }

  // Editor reloads need worktree-relative paths; normalize absolute watcher paths to prevent stale content.
  return normalizeRelativePath(relativePath, worktreePath)
}

export function canonicalizeFileExplorerWatchPath(
  worktreePath: string,
  absolutePath: string
): string | null {
  const relativePath = relativePathInsideRoot(worktreePath, absolutePath)
  if (relativePath === null) {
    return null
  }

  const rootPath = normalizeExplorerAbsolutePath(worktreePath)
  return relativePath === '' ? rootPath : joinPath(rootPath, relativePath)
}

export function createCachedDirPathIndex(
  cache: Record<string, { children: unknown }>,
  keys: readonly string[] = Object.keys(cache)
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const key of keys) {
    const normalizedKey = normalizeRuntimePathForComparison(key)
    if (!index.has(normalizedKey)) {
      index.set(normalizedKey, key)
    }
  }
  return index
}

/** Resolve Windows casing drift lazily; direct cache hits usually avoid normalizing every cached directory. */
export function resolveCachedDirPath(
  cache: Record<string, { children: unknown }>,
  dirPath: string,
  worktreePath?: string,
  cachePathIndex?: () => ReadonlyMap<string, string>
): string | null {
  if (dirPath in cache) {
    return dirPath
  }
  const target = normalizeRuntimePathForComparison(dirPath)
  const indexedPath = cachePathIndex?.().get(target)
  if (indexedPath) {
    return indexedPath
  }
  if (!cachePathIndex) {
    for (const key of Object.keys(cache)) {
      if (normalizeRuntimePathForComparison(key) === target) {
        return key
      }
    }
  }
  if (worktreePath && normalizeRuntimePathForComparison(worktreePath) === target) {
    return normalizeExplorerAbsolutePath(worktreePath)
  }
  return null
}

export function parentDirForWatchPath(normalizedPath: string): string {
  if (!isWindowsAbsolutePathLike(normalizedPath)) {
    const separator = normalizedPath.lastIndexOf('/')
    return separator === -1 ? '.' : normalizedPath.slice(0, separator) || '/'
  }
  const parentPath = dirname(normalizedPath)
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}${normalizedPath.includes('\\') ? '\\' : '/'}`
  }
  return normalizeExplorerAbsolutePath(parentPath)
}
