import { toast } from 'sonner'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { runEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'

/**
 * Ends the host's terminals and Orca's server in its distro, drops the host's records, then
 * refreshes the host list. Anything main could not end is reported, since it keeps the distro up.
 */
async function removeWslHostImpl(environmentId: string): Promise<void> {
  const api = window.api.runtimeEnvironments?.wslHosts
  if (!api) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  const serverStop = await api.remove({ environmentId })
  const state = useAppStore.getState()
  // Why: an active workspace on the removed host would keep calling a host that no longer exists;
  // its rows stay listed as belonging to a removed server.
  if (
    state.activeWorktreeId &&
    workspaceOwnerHostId(state, state.activeWorktreeId) === toRuntimeExecutionHostId(environmentId)
  ) {
    state.setActiveWorktree(null)
  }
  state.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  // Why `=== false`: an older main answered nothing here.
  if (serverStop?.stopped === false) {
    // Why it stays up: it names what still runs in the distro, which the user has to act on.
    toast.warning(
      translate(
        'auto.components.sidebar.wslHostRemoval.partial',
        'The host was removed, but something in the distro is still running: {{value0}}',
        { value0: serverStop.reason }
      ),
      { duration: Infinity }
    )
  }
}

export async function removeWslHost(environmentId: string): Promise<void> {
  return runEnclosingWorktreeRemoval({ hostId: toRuntimeExecutionHostId(environmentId) }, () =>
    removeWslHostImpl(environmentId)
  )
}
