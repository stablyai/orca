import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  type RuntimeAwareSshReadState
} from '@/store/slices/runtime-environment-ssh'

/**
 * SSH status behind the card's "SSH disconnected" chip and blocking dialog.
 * `environmentId` is the remote Orca server owning the target (null = this
 * machine); null status means unknown/no target — show nothing.
 */
export function selectWorktreeCardSshStatus(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  connectionId: string | null | undefined
): SshConnectionStatus | null {
  // Why: runtime-owned SSH targets suppress their ssh:state-changed broadcasts, so don't show a false "disconnected" chip for them.
  if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
    return null
  }
  return selectRuntimeAwareSshStatus(state, environmentId, connectionId)
}

export function selectWorktreeCardSshTargetLabel(
  state: RuntimeAwareSshReadState,
  environmentId: string | null,
  connectionId: string | null | undefined
): string {
  if (!connectionId) {
    return ''
  }
  if (environmentId === null) {
    // Why: keep the card's historical '' fallback for local targets so the dialog falls back to repo.displayName.
    return state.sshTargetLabels.get(connectionId) ?? ''
  }
  const label = selectRuntimeAwareSshTargetLabel(state, environmentId, connectionId)
  // Why: the runtime-aware fallback is the raw target id, meaningless in the dialog; '' defers to repo.displayName instead.
  return label === connectionId ? '' : label
}
