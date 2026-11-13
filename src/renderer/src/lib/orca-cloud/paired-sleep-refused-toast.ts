// SHARED-MEMBER-SLEEP-HANG: only a workspace's owner or a team admin may put it to sleep; the control
// plane refuses anyone else. A member's Sleep on a teammate's shared workspace says so (a permission
// precondition, so the warning tone), instead of hanging on "Saving copy…" or "still running".
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'

/** The disabled Sleep item's hint. */
export function pairedSleepOwnerOnlyHint(): string {
  return translate(
    'orcaCloudWorkspace.sleepOwnerOnly',
    'Only its owner or a team admin can put it to sleep.'
  )
}

export function showPairedSleepRefusedToast(name: string, id: string = name): void {
  toast.warning(
    translate('orcaCloudWorkspace.sleepRefusedTitle', 'Couldn’t put {{name}} to sleep', { name }),
    {
      id: `paired-sleep-refused:${id}`,
      description: translate(
        'orcaCloudWorkspace.sleepRefusedDescription',
        'Only its owner or a team admin can do that.'
      )
    }
  )
}

export function toastPairedSleepRefused(worktreeIds: readonly string[]): void {
  for (const id of new Set(worktreeIds)) {
    showPairedSleepRefusedToast(findWorktreeById(useAppStore.getState(), id)?.displayName ?? '', id)
  }
}
