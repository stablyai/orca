import type { RemoteRuntimeClientError } from '../../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import type { SharedControlSocketGeneration } from './remote-runtime-shared-control-socket-generation'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

/**
 * Closes a shared control socket after an error and schedules its retry. A refused token is
 * refused on every retry, so an owner that can pair again takes over instead, and waiting callers
 * see a connection that will return rather than a refusal while it does.
 */
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
  // Why closed only: an on-demand open may already be under way when the recovery settles.
  // A recovery that threw leaves no owner, so the socket retries as usual.
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
