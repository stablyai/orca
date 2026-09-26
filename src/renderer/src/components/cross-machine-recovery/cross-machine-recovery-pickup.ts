import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type {
  CcSyncPickup,
  CcSyncProgress
} from '../../../../shared/cross-machine-recovery-provider-types'
import type {
  CrossMachineRecoveryDivergence,
  CrossMachineRecoveryProviderResult
} from '../../../../shared/cross-machine-recovery-provider-ipc'

export type RecoveryPickupHandle = {
  cancel: () => Promise<void>
  result: Promise<CrossMachineRecoveryProviderResult<CcSyncPickup>>
}

// Why: pickup always targets this computer's Orca, so it goes through the desktop-only bridge and
// never through runtime.call, which a remote environment would reroute.
export function startRecoveryPickup(args: {
  selector: string
  resume: string[]
  onDivergence?: CrossMachineRecoveryDivergence
  onProgress: (progress: CcSyncProgress) => void
}): RecoveryPickupHandle {
  const api = window.api.crossMachineRecovery
  const operationId = createBrowserUuid()
  const unsubscribe = api.onPickupProgress((event) => {
    if (event.operationId === operationId) {
      args.onProgress(event.progress)
    }
  })
  const result = api
    .pickup({
      operationId,
      selector: args.selector,
      resume: args.resume,
      ...(args.onDivergence ? { onDivergence: args.onDivergence } : {})
    })
    .finally(unsubscribe)
  return { cancel: () => api.cancel(operationId), result }
}

/** The import lands out-of-band through the CLI, so the local worktree list may not know it yet. */
export async function revealRecoveredWorktree(worktreeId: string): Promise<boolean> {
  if (activateAndRevealWorktree(worktreeId, { executionHostId: 'local' })) {
    return true
  }
  await useAppStore.getState().fetchAllWorktrees()
  return activateAndRevealWorktree(worktreeId, { executionHostId: 'local' }) !== false
}
