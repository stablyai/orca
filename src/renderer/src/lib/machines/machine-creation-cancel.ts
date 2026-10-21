import { useAppStore } from '@/store'

/**
 * Stops a machine create from its pane. The provider may still finish, so the entry stays for its
 * "Check for a leftover machine" action instead of claiming nothing was made.
 */
export async function cancelMachineCreation(creationId: string): Promise<void> {
  const store = useAppStore.getState()
  const entry = store.pendingWorktreeCreations[creationId]
  const machine = entry?.request.machine
  if (!entry || !machine) {
    return
  }
  store.updatePendingWorktreeCreation(creationId, {
    status: 'error',
    error: undefined,
    machineProgress: { activity: entry.machineProgress?.activity ?? 'creating', canceled: true }
  })
  if (machine.create && !machine.machineId) {
    await window.api.machines.cancelCreate({ operationId: machine.create.operationId })
  }
}
