import { normalizeRuntimePathSeparators } from './cross-platform-path'

export const UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH = 'Unknown location'

function trimRuntimePathTrailingSlash(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value
  }
  return value.replace(/\/+$/, '')
}

export function getExternalWorktreeParentPath(worktreePath: string | undefined): string {
  if (!worktreePath) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  const normalized = trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(worktreePath))
  if (!normalized) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  if (normalized.startsWith('//')) {
    const parts = normalized.slice(2).split('/').filter(Boolean)
    if (parts.length < 2) {
      return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
    }
    if (parts.length === 2) {
      return `//${parts[0]}/${parts[1]}`
    }
    return `//${parts.slice(0, -1).join('/')}`
  }
  const lastSeparatorIndex = normalized.lastIndexOf('/')
  if (lastSeparatorIndex < 0) {
    return UNKNOWN_EXTERNAL_WORKTREE_PARENT_PATH
  }
  if (lastSeparatorIndex === 0) {
    return '/'
  }
  if (/^[A-Za-z]:\/$/.test(normalized)) {
    return normalized
  }
  if (/^[A-Za-z]:\/[^/]+$/.test(normalized)) {
    return `${normalized.slice(0, 2)}/`
  }
  return normalized.slice(0, lastSeparatorIndex)
}
