import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createManagedSshHost } from './managed-ssh-host-create'
import type { SshTargetSavePayload } from './ssh-target-save-payload'

export async function saveSshTargetForm(
  editingId: string | null,
  payload: SshTargetSavePayload,
  provisioningRequestId: { current: string | null }
): Promise<void> {
  if (editingId) {
    await window.api.ssh.updateTarget({ id: editingId, updates: payload.updates })
    toast.success(translate('auto.components.settings.SshPane.b4ba0ce33d', 'Target updated'))
    return
  }
  provisioningRequestId.current ??= crypto.randomUUID()
  await createManagedSshHost(provisioningRequestId.current, payload.target)
}
