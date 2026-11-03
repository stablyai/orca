import { toast } from 'sonner'
import type { LocalBaseRefDriftWarning } from '../../../../../../shared/worktree/base-ref-drift-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { translate } from '@/i18n/i18n'

export function showLocalBaseRefDriftWarningToast(
  warning: LocalBaseRefDriftWarning | undefined,
  createdWorktree: Pick<Worktree, 'id' | 'displayName' | 'branch' | 'path'>
): void {
  if (!warning) {
    return
  }

  const worktreeName = resolveWorktreeDisplayName(createdWorktree).trim()
  const detail =
    warning.relation === 'diverged'
      ? translate(
          'auto.store.slices.worktrees.localBaseRefDriftWarningDiverged',
          'Selected base {{value0}} has {{value1}} commit(s) behind and {{value2}} ahead of {{value3}}.',
          {
            value0: warning.baseRef,
            value1: warning.behind,
            value2: warning.ahead,
            value3: warning.defaultBaseRef
          }
        )
      : translate(
          'auto.store.slices.worktrees.localBaseRefDriftWarningBehind',
          'Selected base {{value0}} is {{value1}} commit(s) behind {{value2}}.',
          {
            value0: warning.baseRef,
            value1: warning.behind,
            value2: warning.defaultBaseRef
          }
        )

  toast.warning(
    worktreeName
      ? translate(
          'auto.store.slices.worktrees.localBaseRefDriftWarningTitleForWorktree',
          'Base ref may be stale for "{{value0}}"',
          { value0: worktreeName }
        )
      : translate(
          'auto.store.slices.worktrees.localBaseRefDriftWarningTitle',
          'Base ref may be stale'
        ),
    { description: detail, id: `local-base-ref-drift-warning:${createdWorktree.id}` }
  )
}
