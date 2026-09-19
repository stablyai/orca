import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { SshTargetCreateInput } from '../../../../shared/ssh-types'

export async function createManagedSshHost(
  requestId: string,
  target: SshTargetCreateInput
): Promise<void> {
  const api = window.api.runtimeEnvironments
  if (typeof api.createOrcadSshHost !== 'function') {
    throw new Error(
      translate(
        'auto.components.settings.ManagedOrcadServersSection.restartForProvisioning',
        'Restart Orca to finish applying the SSH server update.'
      )
    )
  }
  const provisioned = await api.createOrcadSshHost({ requestId, name: target.label, target })
  useAppStore.getState().recordSshRepoReadoptions(provisioned.repoReadoptions)
  try {
    const [targets, environments] = await Promise.all([window.api.ssh.listTargets(), api.list()])
    const store = useAppStore.getState()
    store.setSshTargetsMetadata(targets)
    store.setRuntimeEnvironments(environments)
  } catch {
    toast.error(
      translate(
        'auto.components.settings.ManagedOrcadServersSection.refreshAfterProvisioning',
        'Could not refresh the host list. Open Managed Orca servers to check setup.'
      )
    )
  }
  const result = provisioned.result
  if (result.outcome === 'pending' || result.outcome === 'deferred') {
    toast.info(
      translate(
        'auto.components.settings.ManagedOrcadServersSection.sshSetupPending',
        'Server setup is pending. Resume it in Managed Orca servers.'
      ),
      { description: result.reason }
    )
    return
  }
  toast.success(
    translate(
      'auto.components.settings.ManagedOrcadServersSection.sshSetupComplete',
      'Orca server is ready.'
    )
  )
}
