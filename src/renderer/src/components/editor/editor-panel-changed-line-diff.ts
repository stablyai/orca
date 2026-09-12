import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { canUseChangesModeForFile } from './editor-panel-file-mode'

export function shouldLoadChangedLineDiffForEditFile(
  file: OpenFile | null,
  gitStatusEntries: readonly GitStatusEntry[] | undefined,
  gitBranchEntries?: readonly GitBranchChangeEntry[] | undefined
): boolean {
  if (!file || file.readOnly === true || !canUseChangesModeForFile(file)) {
    return false
  }
  return Boolean(
    gitStatusEntries?.some(
      (entry) => entry.path === file.relativePath && entry.status !== 'deleted'
    ) ||
      gitBranchEntries?.some(
        (entry) => entry.path === file.relativePath && entry.status !== 'deleted'
      )
  )
}

export function getChangedLineDiffFile(
  file: OpenFile,
  gitStatusEntries: readonly GitStatusEntry[] | undefined,
  gitBranchEntries: readonly GitBranchChangeEntry[] | undefined,
  branchCompare: OpenFile['branchCompare'] | null | undefined
): OpenFile | null {
  const hasWorktreeEntry = gitStatusEntries?.some(
    (entry) => entry.path === file.relativePath && entry.status !== 'deleted'
  )
  const branchEntry = gitBranchEntries?.find(
    (entry) => entry.path === file.relativePath && entry.status !== 'deleted'
  )
  if (hasWorktreeEntry || !branchEntry || !branchCompare) {
    return hasWorktreeEntry ? file : null
  }
  return {
    ...file,
    diffSource: 'branch',
    branchCompare,
    branchOldPath: branchEntry.oldPath
  }
}
