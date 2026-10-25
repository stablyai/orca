import type { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import type { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

/** After token refusal, a pairing-capable owner takes recovery; waiting callers see a reconnecting connection. */
export function closeSharedControlAfterError(args: {
  refused: RemoteRuntimeClientError
  socketGeneration: number
  generation: SharedControlSocketGeneration
  onAuthenticationRejected: (() => Promise<'retry' | 'stop'> | null) | undefined
  everReady: boolean
  subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
  closeSocket: (error: RemoteRuntimeClientError) => void
  markError: (message: string) => void
  isClosed: () => boolean
  retry: () => void
  publishDiagnostics: () => void
}): void {
  // Why current only: a racing close of a retired socket must not start a second recovery.
  const recovery =
    args.refused.code === 'unauthorized' && args.generation.isCurrent(args.socketGeneration)
      ? (args.onAuthenticationRejected?.() ?? null)
      : null
  const error = recovery
    ? remoteRuntimeUnavailableError('Remote Orca runtime refused this pairing; pairing again.')
    : args.refused
  if (
    !args.generation.acceptClose({
      generation: args.socketGeneration,
      error,
      everReady: args.everReady,
      subscriptions: args.subscriptions,
      closeSocket: () => args.closeSocket(error)
    })
  ) {
    return
  }
  args.markError(error.message)
  if (!recovery) {
    args.retry()
    args.publishDiagnostics()
    return
  }
  // Recover only while closed: an on-demand open may have started. Failed recovery falls back to retry.
  void recovery
    .catch(() => 'retry' as const)
    .then((next) => {
      if (next === 'retry' && args.isClosed()) {
        args.retry()
        args.publishDiagnostics()
      }
    })
  args.publishDiagnostics()
}
