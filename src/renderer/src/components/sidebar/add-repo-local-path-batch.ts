import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { showSkippedBatchFoldersToast } from './add-repo-skipped-folders-toast'

export type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' }
export type LocalPathAddMode = 'single' | 'batch'

export async function addLocalProjectPaths(
  paths: readonly string[],
  add: (path: string, mode: LocalPathAddMode) => Promise<LocalPathAddResult>,
  isCurrent: () => boolean,
  finish: (repoId: string) => Promise<void>
): Promise<void> {
  const gitRepoIds: string[] = []
  const batch = paths.length > 1
  let skippedCount = 0
  for (const path of paths) {
    const result = await add(path, batch ? 'batch' : 'single')
    if (result.status === 'skipped') {
      skippedCount++
      continue
    }
    if (result.status !== 'completed') {
      return
    }
    if (isGitRepoKind(result.repo)) {
      gitRepoIds.push(result.repo.id)
    }
  }
  if (!isCurrent()) {
    return
  }
  if (skippedCount > 0) {
    showSkippedBatchFoldersToast()
  }
  if (batch && gitRepoIds.length > 0) {
    await finish(gitRepoIds[0])
  }
}
