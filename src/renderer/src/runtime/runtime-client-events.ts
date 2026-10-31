import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../shared/runtime-client-events'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { admitSshConnectionState } from '../../../shared/ssh-retained-payload-admission'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { subscribeRuntimeEnvironment } from './runtime-environment-pairing-refresh'

export type RuntimeClientEventSource = Parameters<typeof subscribeRuntimeEnvironment>[1]
export type RuntimeClientEventInstallation = { baseline: boolean; source: RuntimeClientEventSource }
export type RuntimeClientEventDelivery =
  | RuntimeClientEvent
  | { type: 'terminalSideEffectsReady'; capable: boolean }
export type RuntimeClientEventReceiver = (
  event: RuntimeClientEventDelivery,
  installation?: RuntimeClientEventInstallation
) => void

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: RuntimeClientEventReceiver,
  onError: (error: unknown) => void = console.warn,
  // Control-outage events are lost, not queued. First replay-tagged response is the only signal to resync event-derived mirrors such as per-environment SSH state.
  onReplayedAfterReconnect?: () => void
): Promise<RuntimeClientEventSubscription> {
  const callbacks = {
    onResponse: (response: RuntimeRpcResponse<unknown>) => {
      handleRuntimeClientEventResponse(
        response,
        onEvent,
        onError,
        callbacks,
        onReplayedAfterReconnect
      )
    },
    onError
  }
  const handle = await subscribeRuntimeEnvironment(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
    },
    callbacks
  )
  return { unsubscribe: handle.unsubscribe }
}

function handleRuntimeClientEventResponse(
  response: RuntimeRpcResponse<unknown>,
  onEvent: RuntimeClientEventReceiver,
  onError: (error: unknown) => void,
  source: RuntimeClientEventSource,
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
    onEvent(
      {
        type: 'terminalSideEffectsReady',
        capable: message.snapshot?.terminalSideEffects !== undefined
      },
      { baseline: true, source }
    )
    for (const batch of message.snapshot?.terminalSideEffects ?? []) {
      onEvent(
        { type: 'terminalSideEffects', batch: { ...batch, replay: true } },
        { baseline: true, source }
      )
    }
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
  if (isRuntimeClientEvent(message)) {
    onEvent(
      message,
      message.type === 'terminalSideEffects' ? { baseline: false, source } : undefined
    )
  }
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
