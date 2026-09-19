import { toast } from 'sonner'
import type { OrcadSshPendingProvisioning } from '../../../../shared/orcad-ssh-provisioning'
import {
  managedOrcadPendingSetupId,
  type ManagedOrcadBusyAction
} from './managed-orcad-server-types'
import { deploySuccessMessage } from './managed-orcad-deploy-success'

export async function resumeManagedOrcadProvisioning(
  request: OrcadSshPendingProvisioning,
  actions: {
    setBusyAction: (action: ManagedOrcadBusyAction | null) => void
    clearRowError: (id: string) => void
    setRowError: (id: string, error: unknown) => void
    refreshAfterMutation: () => Promise<void>
  }
): Promise<void> {
  const id = managedOrcadPendingSetupId(request)
  actions.setBusyAction({ id, action: 'resume' })
  actions.clearRowError(id)
  try {
    const { result } = await window.api.runtimeEnvironments.resumeOrcadSshHost({
      requestId: request.requestId
    })
    if (result.outcome === 'pending' || result.outcome === 'deferred') {
      actions.setRowError(id, result.reason)
      return
    }
    toast.success(deploySuccessMessage(result))
    await actions.refreshAfterMutation()
  } catch (error) {
    actions.setRowError(id, error)
  } finally {
    actions.setBusyAction(null)
  }
}
