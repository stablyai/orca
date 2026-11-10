import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { useCloudWorkspace, useIsCloudWorkspace } from './orca-cloud-workspace-store'

export type CloudRecoveryContext = {
  /** A wake is in flight: the waking pill already says what's happening, so no reconnect banner. */
  waking: boolean
  /** What the person calls it (never the sandbox's server name or id). */
  workspaceName: string | null
}

/** For a terminal's recovery notices: null for a workspace that isn't on Orca Cloud. */
export function useCloudRecoveryContext(
  worktreeId: string | null | undefined
): CloudRecoveryContext | null {
  const isCloud = useIsCloudWorkspace(worktreeId)
  const phase = useCloudWorkspace((s) => (worktreeId ? s.wake[worktreeId]?.phase : undefined))
  const workspaceName = useAppStore((state) =>
    worktreeId ? (findWorktreeById(state, worktreeId)?.displayName ?? null) : null
  )
  if (!isCloud) {
    return null
  }
  return { waking: phase === 'waking' || phase === 'connecting', workspaceName }
}
