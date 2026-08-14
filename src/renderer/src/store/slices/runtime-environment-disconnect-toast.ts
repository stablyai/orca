import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'

const activeRuntimeDisconnectedToasts = new Map<string, symbol>()
const RUNTIME_DISCONNECTED_TOAST_DURATION_MS = 4_000

function getRuntimeDisconnectedToastId(environmentId: string): string {
  return `runtime-environment-disconnected:${environmentId}`
}

export function showRuntimeDisconnectedToast(
  environmentId: string,
  getState: () => AppState
): void {
  const environment = getState().runtimeEnvironments.find((entry) => entry.id === environmentId)
  const toastId = getRuntimeDisconnectedToastId(environmentId)
  const activation = Symbol(toastId)
  const title = environment?.name
    ? translate(
        'auto.store.slices.runtime.status.runtimeHostUnreachableNamed',
        "Can't reach {{hostName}}",
        { hostName: environment.name }
      )
    : translate(
        'auto.store.slices.runtime.status.runtimeHostUnreachable',
        "Can't reach Orca server"
      )
  activeRuntimeDisconnectedToasts.set(toastId, activation)
  const clearActiveToast = (): void => {
    if (activeRuntimeDisconnectedToasts.get(toastId) === activation) {
      activeRuntimeDisconnectedToasts.delete(toastId)
    }
  }
  let retrying = false
  const showToast = (duration = RUNTIME_DISCONNECTED_TOAST_DURATION_MS): void => {
    toast.warning(title, {
      id: toastId,
      description: translate(
        'auto.store.slices.runtime.status.runtimeHostDisconnectedDescription',
        'Check that Orca is running on this server and that your network connection is working, then try again.'
      ),
      duration,
      action: {
        label: translate('auto.store.slices.runtime.status.tryAgain', 'Try again'),
        onClick: (event) => {
          // Why: Sonner otherwise deletes the keyed toast after the action callback.
          event.preventDefault()
          if (retrying) {
            return
          }
          retrying = true
          showToast(Number.POSITIVE_INFINITY)
          void getState()
            .refreshRuntimeEnvironmentStatus(environmentId)
            .then((reachable) => {
              const stillSaved = getState().runtimeEnvironments.some(
                (entry) => entry.id === environmentId
              )
              if (
                !reachable &&
                stillSaved &&
                activeRuntimeDisconnectedToasts.get(toastId) === activation
              ) {
                showToast()
              }
            })
            .finally(() => {
              retrying = false
            })
        }
      },
      onDismiss: clearActiveToast,
      onAutoClose: clearActiveToast
    })
  }
  showToast()
}

export function dismissRuntimeDisconnectedToast(environmentId: string): void {
  const toastId = getRuntimeDisconnectedToastId(environmentId)
  if (!activeRuntimeDisconnectedToasts.delete(toastId)) {
    return
  }
  toast.dismiss?.(toastId)
}
