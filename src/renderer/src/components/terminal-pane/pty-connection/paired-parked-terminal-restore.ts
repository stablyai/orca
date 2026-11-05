import { useAppStore } from '@/store'
import '../../../../../shared/protocol-version'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'

export function canRestorePairedParkedTerminal(ptyId: string): boolean {
  const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  if (environmentId === null) {
    return false
  }
  // Retain last-verified capability across contact loss so reattach cannot cold-resume a duplicate (docs/reference/ssh-execution-boundary.md).
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  if (isRuntimeHostContactRevoked(entry)) {
    return false
  }
  const status = lastVerifiedRuntimeStatus(entry)
  return status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY) === true
}

// Daemon worktreeId@@shortUuid IDs prevent cross-workspace reattach.
import '../../../../../shared/terminal/pty/lifecycle/pty-session-id-format'
