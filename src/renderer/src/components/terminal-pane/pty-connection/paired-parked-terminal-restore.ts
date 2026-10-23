import { useAppStore } from '@/store'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../shared/runtime-host-status'

export function canRestorePairedParkedTerminal(ptyId: string): boolean {
  const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  if (environmentId === null) {
    return false
  }
  // Why last-verified: losing contact mid-reattach would otherwise drop the parked session
  // and cold-restore a fresh one. See docs/reference/ssh-execution-boundary.md.
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  if (isRuntimeHostContactRevoked(entry)) {
    return false
  }
  const status = lastVerifiedRuntimeStatus(entry)
  return status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) === true
}

// Why: daemon session IDs use the format `${worktreeId}@@${shortUuid}`, so restore never reattaches
// a session another workspace owns.
export { isPtySessionIdOwnedByWorktree as isSessionOwnedByWorktree } from '../../../../../shared/pty-session-id-format'
