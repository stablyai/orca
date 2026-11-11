import type {
  RuntimeClientEvent,
  RuntimeClientEventStreamMessage
} from '../../../../../shared/runtime-client-events'
import { isNotificationAttentionAcknowledgement } from '../../../../../shared/notification-settings-types'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { isRuntimeSubscriptionReplayResponse } from '../../../../../shared/runtime-subscription-replay'
import { admitSshConnectionState } from '../../../../../shared/ssh-retained-payload-admission'
import { getRuntimeEnvironmentRevision } from '../environment-revisions/runtime-environment-revision'
import { subscribeRuntimeEnvironment } from '../environment-revisions/runtime-environment-pairing-refresh'
import { answerBrowserClientHostRequest } from '../../browser/client-hosting/browser-client-host-request-answer'
import { readHostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence-sync'

export type RuntimeClientEventSubscription = {
  unsubscribe: () => void
}

export async function subscribeRuntimeClientEvents(
  environmentId: string,
  onEvent: (event: RuntimeClientEvent) => void,
  onError: (error: unknown) => void = console.warn,
  // Control-outage events are lost, not queued. First replay-tagged response is the only signal to resync event-derived mirrors such as per-environment SSH state.
  onReplayedAfterReconnect?: () => void,
  // Managed SSH hosts reach this desktop's browser through the desktop browser bridge instead.
  options: { hostsBrowserPages: boolean; onClose?: () => void } = { hostsBrowserPages: false }
): Promise<RuntimeClientEventSubscription> {
  const handle = await subscribeRuntimeEnvironment(
    {
      selector: environmentId,
      method: 'runtime.clientEvents.subscribe',
      // Older servers ignore params; newer ones ask only sockets advertising host requests.
      ...(options.hostsBrowserPages ? { params: { browserHostRequests: true } } : {}),
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
    },
    {
      onResponse: (response) => {
        handleRuntimeClientEventResponse(
          environmentId,
          response,
          onEvent,
          onError,
          onReplayedAfterReconnect
        )
      },
      onError,
      onClose: options.onClose
    }
  )
  return { unsubscribe: handle.unsubscribe }
}

function handleRuntimeClientEventResponse(
  environmentId: string,
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
  if (message.type === 'browserHostRequested') {
    void answerBrowserClientHostRequest(environmentId, message.requestId)
    return
  }
  // The host's own PR auto-refresh setting governs this client's timers for that host's workspaces.
  if (message.type === 'settingsChanged') {
    if (Array.isArray(message.keys) && message.keys.includes('prAutoRefresh')) {
      void readHostPRAutoRefreshCadence(environmentId)
    }
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
    onEvent(message)
  }
}

function isRuntimeClientEvent(
  message: RuntimeClientEventStreamMessage
): message is RuntimeClientEvent {
  return (
    (message.type === 'notificationAttentionAcknowledged' &&
      isNotificationAttentionAcknowledgement(message.acknowledgement)) ||
    message.type === 'reposChanged' ||
    message.type === 'worktreesChanged' ||
    message.type === 'workspaceMetadataSet' ||
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
