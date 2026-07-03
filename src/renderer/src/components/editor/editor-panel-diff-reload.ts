import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/types'

export function isReloadableSingleFileDiffTab(file: OpenFile): boolean {
  return (
    file.mode === 'diff' &&
    file.diffSource !== undefined &&
    file.diffSource !== 'combined-all' &&
    file.diffSource !== 'combined-uncommitted' &&
    file.diffSource !== 'combined-branch' &&
    file.diffSource !== 'combined-commit'
  )
}

function hasReloadableStatusEntry(
  file: OpenFile,
  gitStatusEntries: readonly GitStatusEntry[] | undefined
): boolean {
  if (gitStatusEntries === undefined) {
    return true
  }

  // Why: a diff tab snapshots one status area. If staging/commit moves that
  // row elsewhere, auto-reloading replaces useful context with another diff.
  if (file.diffSource === 'unstaged') {
    return gitStatusEntries.some(
      (entry) =>
        entry.path === file.relativePath &&
        (entry.area === 'unstaged' || entry.area === 'untracked')
    )
  }

  if (file.diffSource === 'staged') {
    return gitStatusEntries.some(
      (entry) => entry.path === file.relativePath && entry.area === 'staged'
    )
  }

  return true
}

export function shouldReloadDiffOnGitStatusChange(
  file: OpenFile,
  gitStatusEntries?: readonly GitStatusEntry[]
): boolean {
  return (
    file.mode === 'diff' &&
    (file.diffSource === 'unstaged' || file.diffSource === 'staged') &&
    hasReloadableStatusEntry(file, gitStatusEntries)
  )
}
