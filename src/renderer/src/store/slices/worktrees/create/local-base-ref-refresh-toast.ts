import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import type { LocalBaseRefRefreshResult } from '../../../../../../shared/worktree/base-ref-drift-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

export function localBaseRefRefreshFailureDetail(result: LocalBaseRefRefreshResult): string {
  const ownerWorktreePath = result.ownerWorktreePath?.trim()
  switch (result.status) {
    case 'skipped_dirty_worktree':
      // Create already succeeded — guide cleanup + manual base update, not "try again".
      return ownerWorktreePath
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirtyNamed',
            'The worktree at {{value0}} (where local {{value1}} is checked out) has uncommitted changes. Commit, stash, or discard those changes, then update local {{value1}} manually.',
            { value0: ownerWorktreePath, value1: result.localBranch }
          )
        : translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailDirty',
            'The worktree where local {{value0}} is checked out has uncommitted changes. Commit, stash, or discard those changes, then update local {{value0}} manually.',
            { value0: result.localBranch }
          )
    case 'skipped_not_fast_forward':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailNotFastForward',
        'Local {{value0}} does not exist or cannot be fast-forwarded cleanly from the remote base. Check for local-only commits before updating it manually.',
        { value0: result.localBranch }
      )
    case 'skipped_error':
      return translate(
        'auto.store.slices.worktrees.localBaseRefRefreshFailedDetailError',
        'Git returned an error while updating local {{value0}}. Check the repo for locked refs or unusual worktree state, then update local {{value0}} manually.',
        { value0: result.localBranch }
      )
    case 'updated':
      return ''
  }
}

export function showLocalBaseRefRefreshToast(
  result: LocalBaseRefRefreshResult | undefined,
  createdWorktree?: Pick<Worktree, 'id' | 'displayName' | 'branch' | 'path'>
): void {
  if (!result || result.status === 'updated') {
    return
  }

  const worktreeName = createdWorktree ? resolveWorktreeDisplayName(createdWorktree).trim() : ''
  const detail = localBaseRefRefreshFailureDetail(result)

  // Why: Infinity so create-time failures aren't buried; id is per worktree so each create stays attributable.
  toast.warning(
    worktreeName
      ? translate(
          'auto.store.slices.worktrees.localBaseRefRefreshFailedForWorktree',
          'Local {{value0}} was not refreshed for "{{value1}}"',
          { value0: result.localBranch, value1: worktreeName }
        )
      : translate('auto.store.slices.worktrees.14bc053a47', 'Local {{value0}} was not refreshed', {
          value0: result.localBranch
        }),
    {
      id: `local-base-ref-refresh-failed:${createdWorktree?.id ?? 'unknown'}:${result.localBranch}`,
      description: worktreeName
        ? translate(
            'auto.store.slices.worktrees.localBaseRefRefreshFailedDescriptionNamed',
            'Workspace "{{value0}}" was created from {{value1}}, but Orca could not fast-forward local {{value2}}. {{value3}}',
            {
              value0: worktreeName,
              value1: result.baseRef,
              value2: result.localBranch,
              value3: detail
            }
          )
        : translate(
            'auto.store.slices.worktrees.903b51c2ed',
            'Workspace created from {{value0}}, but Orca could not fast-forward local {{value1}}. {{value2}}',
            { value0: result.baseRef, value1: result.localBranch, value2: detail }
          ),
      duration: Infinity,
      dismissible: true
    }
  )
}
