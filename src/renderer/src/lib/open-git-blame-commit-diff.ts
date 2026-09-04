import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getRuntimeGitCommitCompare } from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { isUncommittedBlameOid, type GitBlameLine } from '../../../shared/git-blame'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export async function openGitBlameCommitDiff(
  worktreeId: string,
  line: GitBlameLine
): Promise<void> {
  if (isUncommittedBlameOid(line.commitOid)) {
    toast.info(
      translate(
        'auto.components.editor.gitLineBlame.uncommittedToast',
        'This line is not committed yet.'
      )
    )
    return
  }

  const state = useAppStore.getState()
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  const worktreePath =
    worktree?.path ?? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
  if (!worktreePath) {
    toast.error(
      translate('auto.components.editor.gitLineBlame.openFailed', 'Failed to open commit diff')
    )
    return
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((entry) => entry.id === repoId) ?? null
  const settings = getRepoOwnerRoutedSettings(state.settings, repo)
  try {
    const result = await getRuntimeGitCommitCompare(
      {
        settings,
        worktreeId,
        worktreePath,
        connectionId: getConnectionId(worktreeId) ?? undefined
      },
      line.commitOid
    )
    if (result.summary.status !== 'ready') {
      throw new Error(
        result.summary.errorMessage ??
          translate('auto.components.editor.gitLineBlame.openFailed', 'Failed to open commit diff')
      )
    }
    state.openCommitAllDiffs(
      worktreeId,
      worktreePath,
      result.summary,
      result.entries,
      line.summary,
      line.summary
    )
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('auto.components.editor.gitLineBlame.openFailed', 'Failed to open commit diff')
    )
  }
}
