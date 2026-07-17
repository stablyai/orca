import { useAppStore } from '@/store'

// Why: stream service provisioning output onto the same pending-creation
// surface as git progress, correlated by creationId (== serviceProvisionId).
export function subscribeServiceProvisionEvents(creationId: string): (() => void) | undefined {
  return window.api.worktreeServices.onProvisionEvent?.((event) => {
    if (event.provisionId !== creationId) {
      return
    }
    const store = useAppStore.getState()
    const pending = store.pendingWorktreeCreations[creationId]
    if (!pending) {
      return
    }
    store.updatePendingWorktreeCreation(creationId, {
      phase: 'provisioning-services',
      provisioningLog: ((pending.provisioningLog ?? '') + event.chunk).slice(-12_000)
    })
  })
}

// Why: refresh the worktreeId→env map so the new worktree's terminals get
// their service env and the sidebar badge reflects provisioning status.
// Hydration failure must not derail the rest of post-create wiring
// (terminals, agent startup) for a worktree that was created successfully.
export async function hydrateServicesAfterCreate(): Promise<void> {
  await useAppStore
    .getState()
    .hydrateWorktreeServices()
    .catch(() => {})
}
