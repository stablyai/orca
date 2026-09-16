import { joinPath, dirname, normalizeRelativePath } from '@/lib/path'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'

export function normalizeExplorerAbsolutePath(path: string): string {
  return path === '/' || /^[A-Za-z]:[\\/]$/.test(path) ? path : path.replace(/[\\/]+$/, '')
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

  // Why: EditorPanel reloads tabs only from a worktree-relative path, not the watcher's absolute one; normalize or contents go stale.
  return normalizeRelativePath(relativePath)
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
  cache: Record<string, { children: unknown }>
): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const key of Object.keys(cache)) {
    const normalizedKey = normalizeRuntimePathForComparison(key)
    if (!index.has(normalizedKey)) {
      index.set(normalizedKey, key)
    }
  }
  return index
}

/**
 * Map an event path to the dirCache key that should be refreshed.
 * Windows watchers often differ in drive-letter casing from the worktree key.
 *
 * Why the index is a thunk: the direct `dirPath in cache` hit answers nearly every lookup outside
 * Windows casing drift, so building it eagerly costs one normalize per cached dir for nothing.
 */
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
  const parentPath = dirname(normalizedPath)
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}${normalizedPath.includes('\\') ? '\\' : '/'}`
  }
  return normalizeExplorerAbsolutePath(parentPath)
}
