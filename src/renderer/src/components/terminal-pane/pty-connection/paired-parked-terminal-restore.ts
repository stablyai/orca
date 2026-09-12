import { useAppStore } from '@/store'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { REMOTE_PTY_ID_PREFIX } from './pty-connect-limits'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/runtime-host-status'

export function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

export function canRestorePairedParkedTerminal(ptyId: string): boolean {
  const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  if (environmentId === null) {
    return false
  }
  // Why last-verified: losing contact mid-reattach would otherwise drop the parked session
  // and cold-restore a fresh one. See docs/reference/ssh-execution-boundary.md.
  const status = lastVerifiedRuntimeStatus(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  )
  return status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) === true
}

// Why: daemon session IDs use the format `${worktreeId}@@${shortUuid}`.
// This validates that a session ID actually belongs to the given worktree,
// preventing cross-workspace contamination during restore.
export function isSessionOwnedByWorktree(sessionId: string, worktreeId: string): boolean {
  const separatorIdx = sessionId.lastIndexOf('@@')
  if (separatorIdx === -1) {
    return true
  }
  return sessionId.slice(0, separatorIdx) === worktreeId
}
