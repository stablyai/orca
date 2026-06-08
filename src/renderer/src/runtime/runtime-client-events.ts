import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../shared/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void = console.warn
): Promise<RuntimeClientEventSubscription> {
  const handle = await window.api.runtimeEnvironments.subscribe(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      timeoutMs: 15_000
    },
    {
      onResponse: (response) => {
        handleRuntimeClientEventResponse(response, onEvent, onError)
      },
      onError
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handleRuntimeClientEventResponse(
  response: RuntimeRpcResponse<unknown>,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void
): void {
  if (response.ok === false) {
    onError(response.error)
    return
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
    message.type === 'activateWorktree'
  )
}
