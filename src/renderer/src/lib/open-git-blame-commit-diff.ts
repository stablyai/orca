import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveGitBlameRuntimeContext } from '@/lib/git-blame-runtime-context'
import { getRuntimeGitCommitCompare } from '@/runtime/runtime-git-diff-client'
import { useAppStore } from '@/store'
import { isUncommittedBlameOid, type GitBlameLine } from '../../../shared/git-blame'

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
  const context = resolveGitBlameRuntimeContext(worktreeId)
  if (!context) {
    toast.error(
      translate('auto.components.editor.gitLineBlame.openFailed', 'Failed to open commit diff')
    )
    return
  }
  const { worktreePath } = context
  try {
    const result = await getRuntimeGitCommitCompare(context, line.commitOid)
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
