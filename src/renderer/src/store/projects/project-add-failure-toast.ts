import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { trackSshConnect } from '../../ssh/ssh-connect-in-flight'
import { ERROR_TOAST_DURATION } from '../repos/repo-state'
import { SshProjectHostWithoutServerError } from './project-host-routing'

/** An SSH host without a server gets a Connect action, since connecting sets its server up. */
export function toastProjectAddFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const sshTargetId = err instanceof SshProjectHostWithoutServerError ? err.targetId : null
  toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
    description: message,
    duration: ERROR_TOAST_DURATION,
    ...(sshTargetId
      ? {
          action: {
            label: translate('auto.components.NewWorkspaceComposerCard.connectHost', 'Connect'),
            onClick: () => {
              trackSshConnect(sshTargetId, window.api.ssh.connect({ targetId: sshTargetId })).catch(
                async (connectError: unknown) => {
                  // Lazy: the failure toast reads the store this slice belongs to.
                  const { toastSshConnectFailure } =
                    await import('../../ssh/ssh-connect-failure-toast')
                  toastSshConnectFailure(
                    sshTargetId,
                    connectError,
                    translate(
                      'auto.components.sidebar.useAddRepoHostSelection.connectionFailed',
                      'SSH connection failed.'
                    )
                  )
                }
              )
            }
          }
        }
      : {})
  })
}
