import { joinPath, normalizeRelativePath } from '@/lib/path'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators,
  relativePathInsideRoot
} from '../../../../shared/cross-platform-path'
import { splitPathSegments } from './path-tree'

export function normalizeAbsolutePath(path: string): string {
  const normalizedPath = normalizeRuntimePathSeparators(path)

  if (normalizedPath === '/') {
    return normalizedPath
  }

  if (/^[A-Za-z]:\/$/.test(normalizedPath)) {
    return normalizedPath
  }

  return normalizedPath.replace(/\/+$/, '')
}

export function normalizeAbsolutePathForComparison(path: string): string {
  return normalizeRuntimePathForComparison(path)
}

export function isPathEqualOrDescendant(candidatePath: string, targetPath: string): boolean {
  return isPathInsideOrEqual(targetPath, candidatePath)
}

export function getRevealAncestorDirs(worktreePath: string, filePath: string): string[] | null {
  const relativePath = relativePathInsideRoot(worktreePath, filePath)
  if (relativePath === null) {
    return null
  }

  const segments = splitPathSegments(normalizeRelativePath(relativePath))
  const ancestorDirs: string[] = []
  let currentPath = worktreePath

  for (const segment of segments.slice(0, -1)) {
    currentPath = joinPath(currentPath, segment)
    ancestorDirs.push(currentPath)
  }

  return ancestorDirs
}
