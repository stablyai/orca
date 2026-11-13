import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useCloudWorkspace, useIsCloudWorkspace } from './orca-cloud-workspace-store'
import { isWakeReadyAfterRead } from './orca-cloud-workspace-state'
import { useWakeAfterSleep } from '@/lib/worktree-sleep-wake-request'

export type CloudRecoveryContext = {
  /** A wake is in flight: the waking pill already says what's happening, so no reconnect banner. */
  waking: boolean
  /** Asleep or going to sleep: nothing to reconnect to, so a calm note instead of "Reconnecting" (RA-12). */
  asleep: boolean
  /** What the person calls it (never the sandbox's server name or id). */
  workspaceName: string | null
  /** While asleep or waking: when it went to sleep (the local record's suspend time); null if unknown. */
  asleepSince: number | null
}

/** For a terminal's recovery notices: null for a workspace that isn't on Orca Cloud. */
export function useCloudRecoveryContext(
  worktreeId: string | null | undefined
): CloudRecoveryContext | null {
  // ASLEEP-SR-RECONNECTING: a paired cloud workspace is cloud here too. Owned-only left its asleep
  // and waking states unknown to the recovery notices, so the outage notice ("Reconnecting to …",
  // a polite live region) stayed up under the asleep view and a screen reader announced it.
  const owned = useIsCloudWorkspace(worktreeId)
  const paired = useCloudWorkspace((s) => Boolean(worktreeId && worktreeId in s.paired))
  const isCloud = owned || paired
  const wake = useCloudWorkspace((s) => (worktreeId ? s.wake[worktreeId] : undefined))
  const phase = wake?.phase
  const status = useCloudWorkspace((s) => (worktreeId ? s.status[worktreeId]?.status : undefined))
  // Wake pressed while main still suspends the VM: waking already shows from the press, before
  // main reports, while the connection drops as the VM goes down.
  const wakeAfterSleep = useWakeAfterSleep(worktreeId ?? '')
  const reported = useCloudWorkspace((s) =>
    worktreeId ? s.status[worktreeId]?.status?.state : undefined
  )
  // The local record flips the moment this computer puts it to sleep; the status poll lags.
  const vmSuspended = useAppStore((state) =>
    worktreeId
      ? state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId]?.status === 'suspended'
      : false
  )
  const suspendedAt = useAppStore((state) => {
    const record = worktreeId ? state.ephemeralVmRuntimesByWorkspaceId?.[worktreeId] : undefined
    return record?.status === 'suspended' ? (record.updatedAt ?? null) : null
  })
  const workspaceName = useAppStore((state) =>
    worktreeId ? (findWorktreeById(state, worktreeId)?.displayName ?? null) : null
  )
  if (!isCloud) {
    return null
  }
  const waking = phase === 'waking' || phase === 'connecting' || wakeAfterSleep !== undefined
  // Main said the wake is ready after the last reads: they are stale, and the terminal is about to
  // attach ("Connecting…"), so no asleep note on the way in.
  const asleep =
    !waking &&
    !isWakeReadyAfterRead(wake, status) &&
    (reported === 'sleeping' || reported === 'stopping' || reported === 'archived' || vmSuspended)
  return { waking, asleep, workspaceName, asleepSince: asleep || waking ? suspendedAt : null }
}
