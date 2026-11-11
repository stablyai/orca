import { useCloudRecoveryContext } from '@/lib/orca-cloud/use-cloud-recovery-context'
import { useIsWorktreeGoingToSleep, useIsWorktreeSleepViewHeld } from '@/lib/worktree-sleep-view'

/**
 * An Orca Cloud workspace whose setup script can't be inspected right now: asleep (RA-12), going
 * to sleep, or kept on screen read-only after Sleep (RA-13b). The setup-script card waits instead
 * of showing "Couldn't verify this repo's setup script" with Retry.
 */
export function useSetupScriptAsleepCloud(worktreeId: string | null | undefined): boolean {
  const asleep = useCloudRecoveryContext(worktreeId)?.asleep === true
  const goingToSleep = useIsWorktreeGoingToSleep(worktreeId ?? null)
  const viewOnly = useIsWorktreeSleepViewHeld(worktreeId ?? null)
  return asleep || goingToSleep || viewOnly
}
