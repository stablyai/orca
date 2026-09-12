import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ManagedOrcadBusyAction } from './managed-orcad-server-types'

export async function cancelManagedOrcadStopFromSettings(
  id: string,
  actions: {
    setBusyAction: (action: ManagedOrcadBusyAction | null) => void
    clearRowError: (id: string) => void
    setRowError: (id: string, error: unknown) => void
    refreshAfterMutation: () => Promise<void>
  }
): Promise<void> {
  actions.setBusyAction({ id, action: 'cancel-stop' })
  actions.clearRowError(id)
  try {
    const result = await window.api.runtimeEnvironments.cancelOrcadStop({ selector: id })
    if (result.outcome === 'refused' || result.outcome === 'pending') {
      actions.setRowError(id, result.reason)
      return
    }
    if (result.outcome === 'canceled') {
      toast.success(
        translate('managedOrcad.stopCanceled', 'Stop canceled. The server remains linked.')
      )
    } else {
      actions.setRowError(
        id,
        translate(
          'managedOrcad.noPendingStop',
          'No pending stop transaction was found. Cancellation was not confirmed.'
        )
      )
    }
    await actions.refreshAfterMutation()
  } catch (error) {
    actions.setRowError(id, error)
  } finally {
    actions.setBusyAction(null)
  }
}
