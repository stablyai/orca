import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../shared/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void = console.warn,
  // Control-outage events are lost, not queued. First replay-tagged response is the only signal to resync event-derived mirrors such as per-environment SSH state.
  onReplayedAfterReconnect?: () => void
): Promise<RuntimeClientEventSubscription> {
  const handle = await subscribeRuntimeEnvironment(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
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
  if (message.type === 'ready') {
    for (const sshState of message.snapshot?.sshStates ?? []) {
      const state = admitSshConnectionState(sshState.state, sshState.targetId)
      if (state) {
        onEvent({ type: 'sshStateChanged', targetId: sshState.targetId, state })
      } else {
        onError(new Error('Invalid retained SSH connection state'))
      }
    }
    return
  }
  if (message.type === 'end') {
    return
  }
  if (message.type === 'sshStateChanged') {
    const state = admitSshConnectionState(message.state, message.targetId)
    if (state) {
      onEvent({ type: 'sshStateChanged', targetId: message.targetId, state })
    } else {
      onError(new Error('Invalid retained SSH connection state'))
    }
    return
  }
  if (message.type === 'terminalSavedRestoreFresh') {
    if (isTerminalSavedRestoreFresh(message)) {
      onEvent(message)
    }
    return
  }
  if (isRuntimeClientEvent(message)) {
    onEvent(message)
  }
}

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512
const isOptionalId = (value: unknown): boolean => value === undefined || isId(value)

/** A host's fresh-start notice reaches a pane only with every identity field it is matched on. */
function isTerminalSavedRestoreFresh(
  message: Extract<RuntimeClientEvent, { type: 'terminalSavedRestoreFresh' }>
): boolean {
  return (
    isId(message.paneKey) &&
    isId(message.ptyId) &&
    isId(message.dispatchId) &&
    isOptionalId(message.incarnationId) &&
    isOptionalId(message.launchToken)
  )
}

function isRuntimeClientEvent(
  message: RuntimeClientEventStreamMessage
): message is RuntimeClientEvent {
  return (
    message.type === 'reposChanged' ||
    message.type === 'worktreesChanged' ||
    message.type === 'nativeChatLaunchDraftResolved' ||
    message.type === 'terminalSideEffects' ||
    message.type === 'sshStateChanged' ||
    message.type === 'automationsChanged' ||
    message.type === 'browserProfilesChanged' ||
    message.type === 'linearLinkedIssueUpdated' ||
    message.type === 'activateWorktree' ||
    message.type === 'worktreeTerminalSleepState' ||
    message.type === 'workspaceViewChanged'
  )
}
