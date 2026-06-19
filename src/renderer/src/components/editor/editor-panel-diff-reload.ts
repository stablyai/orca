import type { OpenFile } from '@/store/slices/editor'

export function isReloadableSingleFileDiffTab(file: OpenFile): boolean {
  return (
    file.mode === 'diff' &&
    file.diffSource !== undefined &&
    file.diffSource !== 'combined-uncommitted' &&
    file.diffSource !== 'combined-branch' &&
    file.diffSource !== 'combined-commit'
  )
}

export function shouldReloadDiffOnGitStatusChange(file: OpenFile): boolean {
  return file.mode === 'diff' && (file.diffSource === 'unstaged' || file.diffSource === 'staged')
}
