import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebClient } from '../components/sidebar/worktree-card-model'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'

// Web transport messages the shared classifier doesn't list: the connection waiter's deadline and
// a socket that dropped mid-request.
const WEB_CONNECTION_FAILURE_FRAGMENTS = [
  'timed out while connecting to the remote orca runtime',
  'remote orca runtime connection interrupted'
]

function isConnectionFailure(error: unknown): boolean {
  const like = toRemoteRuntimeClientErrorLike(error)
  const message = like.message.toLowerCase()
  return (
    isRecoverableRemoteRuntimeConnectionError(like) ||
    WEB_CONNECTION_FAILURE_FRAGMENTS.some((fragment) => message.includes(fragment))
  )
}

function hasReadyTransport(snapshots: readonly RuntimeHostStatusSnapshot[]): boolean {
  return snapshots.some((snapshot) => snapshot.transport === 'ready' && !snapshot.retired)
}

/** Web host supplies catalog, so down transport can fail otherwise untouched hydration. Ready-socket failures remain real hydration faults. */
export async function isWebHostUnreachableAtStartup(error: unknown): Promise<boolean> {
  if (!isWebClient() || !isConnectionFailure(error)) {
    return false
  }
  try {
    const snapshots = (await window.api.runtimeEnvironments?.getStatusSnapshots?.()) ?? []
    return !hasReadyTransport(snapshots)
  } catch {
    return true
  }
}

/** Report unreachable host and reload cleanly when its independently reconnecting transport becomes ready. */
export function announceWebHostUnreachableAtStartup(signal: AbortSignal): void {
  const reload = (): void => {
    void window.api.app.relaunch()
  }
  toast.error(translate('auto.startup.webHostUnreachable.title', "Couldn't reach your Orca host"), {
    description: translate(
      'auto.startup.webHostUnreachable.description',
      "Nothing was lost. Orca will reload when the host answers, and won't save changes until then."
    ),
    duration: Infinity,
    dismissible: true,
    action: {
      label: translate('auto.startup.webHostUnreachable.retry', 'Retry now'),
      onClick: reload
    }
  })
  let reloading = false
  let unsubscribe: (() => void) | undefined
  const reloadOnce = (snapshots: readonly RuntimeHostStatusSnapshot[]): void => {
    if (!reloading && hasReadyTransport(snapshots)) {
      reloading = true
      unsubscribe?.()
      reload()
    }
  }
  const statusApi = window.api.runtimeEnvironments
  unsubscribe = statusApi?.onStatusChanged?.((snapshot) => reloadOnce([snapshot]))
  // A torn-down startup pass (StrictMode, window reuse) must not reload the renderer later.
  signal.addEventListener(
    'abort',
    () => {
      reloading = true
      unsubscribe?.()
    },
    { once: true }
  )
  // A reconnect that landed between the unreachable check and subscribing publishes nothing new.
  void statusApi
    ?.getStatusSnapshots?.()
    .then(reloadOnce)
    .catch(() => {})
}
