import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { clearStalePendingReveal } from './file-explorer-watcher-reconcile'
import {
  canonicalizeFileExplorerWatchPath,
  getExternalFileChangeRelativePath,
  normalizeExplorerAbsolutePath,
  parentDirForWatchPath
} from './file-explorer-watch-path'

describe('Explorer watcher filename identity', () => {
  it('does not clear a nested pending reveal when a distinct literal-backslash path is deleted', () => {
    const previous = useAppStore.getState().pendingExplorerReveal
    const pending = { worktreeId: 'wt-posix', filePath: '/repo/a/b/file.txt', requestId: 1 }
    try {
      useAppStore.setState({ pendingExplorerReveal: pending })
      clearStalePendingReveal('/repo/a\\b')
      expect(useAppStore.getState().pendingExplorerReveal).toEqual(pending)
      clearStalePendingReveal('/repo/a/b')
      expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
    } finally {
      useAppStore.setState({ pendingExplorerReveal: previous })
    }
  })

  it.each(['/repo', '/ssh/repo\\'])(
    'preserves POSIX backslashes in watched roots, filenames and parents under %s',
    (root) => {
      expect(normalizeExplorerAbsolutePath(`${root}/`)).toBe(root)
      expect(canonicalizeFileExplorerWatchPath(root, `${root}/a\\b.txt`)).toBe(`${root}/a\\b.txt`)
      expect(getExternalFileChangeRelativePath(root, `${root}/a\\b.txt`, false)).toBe('a\\b.txt')
      expect(parentDirForWatchPath(`${root}/a\\b.txt`)).toBe(root)
      expect(parentDirForWatchPath(`${root}/a\\/b.txt`)).toBe(`${root}/a\\`)
    }
  )

  it.each(['C:\\repo', '\\\\server\\share\\repo'])(
    'retains Windows watcher separator semantics under %s',
    (root) => {
      expect(normalizeExplorerAbsolutePath(`${root}\\`)).toBe(root)
      expect(getExternalFileChangeRelativePath(root, `${root}\\a\\b.txt`, false)).toBe('a/b.txt')
      expect(parentDirForWatchPath(`${root}\\a\\b.txt`)).toBe(`${root}\\a`)
    }
  )
})
