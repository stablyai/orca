import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { markOnboardingProjectAdded } from './onboarding-project-checklist'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function showQuickChatFailure(): void {
  toast.error(
    translate('quickChat.failed', 'Could not start a chat. Check the Chats folder and try again.')
  )
}

export async function startQuickChat(): Promise<string | null> {
  try {
    const { path, repoId } = await window.api.repos.ensureQuickChatFolder()
    const store = useAppStore.getState()
    const repo =
      store.repos.find(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ) ??
      (await store.addRepoPath(path, 'folder', {
        runtimeEnvironmentId: null,
        displayName: translate('quickChat.projectName', 'Chats')
      }))
    // addRepoPath owns its failure toast.
    if (!repo) {
      return null
    }
    void markOnboardingProjectAdded('addedFolder').catch(() => {})
    if (!(await store.fetchWorktrees(repo.id, { executionHostId: LOCAL_EXECUTION_HOST_ID }))) {
      showQuickChatFailure()
      return null
    }
    const worktree = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
      (worktree) => worktree.hostId === LOCAL_EXECUTION_HOST_ID
    )
    if (!worktree) {
      showQuickChatFailure()
      return null
    }
    return worktree.id
  } catch {
    showQuickChatFailure()
    return null
  }
}
