import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../shared/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void = console.warn,
  // Why: client events emitted while the shared-control transport was down are
  // lost, not queued. The replay tag on the first post-reconnect response is
  // the renderer's only signal that mirrored event-derived state (e.g. the
  // per-environment SSH bucket) may have missed transitions and must resync.
  onReplayedAfterReconnect?: () => void
): Promise<RuntimeClientEventSubscription> {
  const handle = await window.api.runtimeEnvironments.subscribe(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      timeoutMs: 15_000
    },
    {
      onResponse: (response) => {
        handleRuntimeClientEventResponse(response, onEvent, onError, onReplayedAfterReconnect)
      },
      onError
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handleRuntimeClientEventResponse(
  response: RuntimeRpcResponse<unknown>,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void,
  onReplayedAfterReconnect?: () => void
): void {
  if (response.ok === false) {
    onError(response.error)
    return
  }
  if (isRuntimeSubscriptionReplayResponse(response)) {
    onReplayedAfterReconnect?.()
  }
  const message = response.result as RuntimeClientEventStreamMessage
  if (message.type === 'ready' || message.type === 'end') {
    return
  }
  if (isRuntimeClientEvent(message)) {
    onEvent(message)
  }
}

function isRuntimeClientEvent(
  message: RuntimeClientEventStreamMessage
): message is RuntimeClientEvent {
  return (
    message.type === 'reposChanged' ||
    message.type === 'worktreesChanged' ||
    message.type === 'sshStateChanged' ||
    message.type === 'linearLinkedIssueUpdated' ||
    message.type === 'activateWorktree' ||
    message.type === 'worktreeTerminalSleepState'
  )
}
