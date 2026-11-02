import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { ERROR_TOAST_DURATION } from './repo-state'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'

/** An unreachable paired server gets a local-removal action instead of a dead-end error. */
export function toastProjectRemovalFailure(
  error: unknown,
  options: { hostUnreachable: boolean; removeLocally: () => void }
): void {
  toast.error(
    translate('auto.store.slices.repos.removeProjectFailed', 'Failed to remove project'),
    {
      description: !options.hostUnreachable
        ? (readIpcErrorMessage(error) ?? String(error))
        : hasRuntimeRpcErrorCode(error, 'runtime_manually_disconnected')
          ? translate(
              'auto.store.slices.repos.removeProjectHostDisconnected',
              'Its server is disconnected. Remove it from this desktop now, and Orca removes it from the server when you reconnect.'
            )
          : translate(
              'auto.store.slices.repos.removeProjectHostUnreachable',
              'Its server can’t be reached. Remove it from this desktop now, and Orca removes it from the server when it reconnects.'
            ),
      duration: ERROR_TOAST_DURATION,
      ...(options.hostUnreachable
        ? {
            action: {
              label: translate(
                'auto.store.slices.repos.removeProjectLocallyNow',
                'Remove from this desktop now'
              ),
              onClick: options.removeLocally
            }
          }
        : {})
    }
  )
}
