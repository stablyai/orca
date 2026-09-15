import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'

type LocalPathAddResult =
  | { status: 'completed'; repo: Repo }
  | { status: 'cancelled' | 'paused' | 'skipped' }

export async function addLocalPathBatch(args: {
  paths: string[]
  source: AddRepoExistingWorkspaceSource
  generation: number
  isCurrentGeneration: () => boolean
  addPath: (
    path: string,
    source: AddRepoExistingWorkspaceSource,
    generation: number,
    mode: 'single' | 'batch'
  ) => Promise<LocalPathAddResult>
  onGitRepoReady: (
    repoId: string,
    source: AddRepoExistingWorkspaceSource,
    executionHostId?: ExecutionHostId
  ) => Promise<void>
  executionHostId: ExecutionHostId | undefined
}): Promise<void> {
  const gitRepoIds: string[] = []
  const shouldDeferGitRepoReady = args.paths.length > 1
  let skippedCount = 0
  for (const path of args.paths) {
    const result = await args.addPath(
      path,
      args.source,
      args.generation,
      shouldDeferGitRepoReady ? 'batch' : 'single'
    )
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
  if (!args.isCurrentGeneration()) {
    return
  }
  if (skippedCount > 0) {
    toast.info(
      translate(
        'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFolders',
        'Some folders were skipped'
      ),
      {
        description: translate(
          'auto.components.sidebar.useAddRepoLocalFolderFlow.skippedBatchFoldersDescription',
          'Add skipped folders individually to review or confirm them.'
        )
      }
    )
  }
  if (shouldDeferGitRepoReady && gitRepoIds.length > 0) {
    await args.onGitRepoReady(gitRepoIds[0], args.source, args.executionHostId)
  }
}
