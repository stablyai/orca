import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useCloudWorkspace, useIsCloudWorkspace } from './orca-cloud-workspace-store'

export type CloudRecoveryContext = {
  /** A wake is in flight: the waking pill already says what's happening, so no reconnect banner. */
  waking: boolean
  /** Asleep or going to sleep: nothing to reconnect to, so a calm note instead of "Reconnecting" (RA-12). */
  asleep: boolean
  /** What the person calls it (never the sandbox's server name or id). */
  workspaceName: string | null
}

/** For a terminal's recovery notices: null for a workspace that isn't on Orca Cloud. */
export function useCloudRecoveryContext(
  worktreeId: string | null | undefined
): CloudRecoveryContext | null {
  const isCloud = useIsCloudWorkspace(worktreeId)
  const phase = useCloudWorkspace((s) => (worktreeId ? s.wake[worktreeId]?.phase : undefined))
  const reported = useCloudWorkspace((s) =>
    worktreeId ? s.status[worktreeId]?.status?.state : undefined
  )
  // The local record flips the moment this computer puts it to sleep; the status poll lags.
  const vmSuspended = useAppStore((state) =>
    worktreeId
      ? state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]?.status === 'suspended'
      : false
  )
  const workspaceName = useAppStore((state) =>
    worktreeId ? (findWorktreeById(state, worktreeId)?.displayName ?? null) : null
  )
  if (!isCloud) {
    return null
  }
  const waking = phase === 'waking' || phase === 'connecting'
  const asleep =
    !waking &&
    (reported === 'sleeping' || reported === 'stopping' || reported === 'archived' || vmSuspended)
  return { waking, asleep, workspaceName }
}
