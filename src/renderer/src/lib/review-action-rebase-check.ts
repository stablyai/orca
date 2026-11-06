import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRuntimeGitRebaseOperation } from '@/runtime/source-control/git/runtime-git-status-client'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GitRebaseOperationState } from '../../../shared/git/status/git-status-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { workspaceKindForWorktreeId } from '../../../shared/workspace-launch-kind'
import { resolveWorktreeGitCopy } from './worktree-git-copy'
import { translate } from '@/i18n/i18n'

type OwnerRebaseRead = GitRebaseOperationState | 'not-git' | 'host-outdated'

async function readOwnerRebaseOperation(
  worktreeId: string,
  hostId: ExecutionHostId | null | undefined
): Promise<OwnerRebaseRead> {
  const state = useAppStore.getState()
  if (workspaceKindForWorktreeId(worktreeId) !== 'git-worktree') {
    return 'not-git'
  }
  const copy = resolveWorktreeGitCopy(state, worktreeId, hostId)
  const worktree = copy ? state.getKnownWorktreeById(worktreeId, copy.hostId ?? undefined) : null
  if (!copy || !worktree) {
    return 'unverifiable'
  }
  const repo = state.repos.find((entry) => entry.id === worktree.repoId)
  if (repo && isFolderRepo(repo)) {
    return 'not-git'
  }
  try {
    const result = await getRuntimeGitRebaseOperation({
      target: copy.transport,
      worktreeId,
      worktreePath: worktree.path,
      connectionId: copy.connectionId
    })
    // Older hosts omit the verdict; that is unverified, not proof that no rebase is running.
    return result.rebaseOperation ?? 'host-outdated'
  } catch {
    return 'unverifiable'
  }
}

function blockedMessage(read: OwnerRebaseRead): string {
  if (read === 'active') {
    return translate(
      'auto.lib.review.action.rebase.check.c6341f933d',
      'A rebase is in progress in this workspace. Continue or abort it before starting this action.'
    )
  }
  if (read === 'host-outdated') {
    return translate(
      'auto.lib.review.action.rebase.check.87b429b921',
      "Update this workspace's host to start this action; it cannot report whether a rebase is in progress."
    )
  }
  return translate(
    'auto.lib.review.action.rebase.check.4adef3e9ff',
    'Could not verify that no rebase is in progress in this workspace, so the action was not started.'
  )
}

/**
 * Fresh owner-side proof, read at the action boundary, that no rebase is running in the workspace
 * a review action will work in. A cached row may still say attached after a rebase started.
 */
export async function confirmNoRebaseBeforeReviewAction(
  worktreeId: string,
  hostId?: ExecutionHostId | null
): Promise<boolean> {
  const read = await readOwnerRebaseOperation(worktreeId, hostId)
  if (read === 'none' || read === 'not-git') {
    return true
  }
  toast.error(blockedMessage(read))
  return false
}
