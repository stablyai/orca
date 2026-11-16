import { getSelectedRepoSshGate } from '@/lib/workspace/creation/new-workspace-ssh-gate'
import { selectRepoSshGateInput } from '@/lib/workspace/catalog/repo-ssh-connection'
import type { RuntimeAwareSshStatusState } from '@/store/slices/ssh/runtime-environment-ssh-selectors'

/** The composer's selected-repo SSH connection, its state, and whether creation must wait on it. */
export function selectComposerRepoSshGate(
  state: RuntimeAwareSshStatusState,
  selectedRepo: Parameters<typeof selectRepoSshGateInput>[1] | null | undefined
) {
  // Why the shared gate: a paired server's own SSH target is read from that server (#25887).
  const selectedRepoSshGateInput = selectedRepo ? selectRepoSshGateInput(state, selectedRepo) : null
  const selectedRepoConnectionId = selectedRepoSshGateInput?.connectionId ?? null
  const selectedRepoSshState = state.sshConnectionStates.get(selectedRepoConnectionId ?? '') ?? null
  const { selectedRepoSshStatus, selectedRepoRequiresConnection, selectedRepoConnectInProgress } =
    getSelectedRepoSshGate({
      connectionId: selectedRepoConnectionId,
      status: selectedRepoSshGateInput?.status ?? null
    })
  return {
    selectedRepoConnectionId,
    selectedRepoSshState,
    selectedRepoSshStatus,
    selectedRepoRequiresConnection,
    selectedRepoConnectInProgress
  }
}
