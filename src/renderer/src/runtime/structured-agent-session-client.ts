import { translate } from '@/i18n/i18n'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  AGENT_SESSION_FORK_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'

/** The paired runtime is too old for this method. Thrown BEFORE any request leaves the client, so
 *  a caller may report the real reason and retire the attempt: no session was created. */
export class StructuredAgentSessionCapabilityError extends Error {}

export async function callStructuredAgentSession<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
): Promise<TResult> {
  if (
    method === 'agentSession.rewind' &&
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      AGENT_SESSION_REWIND_RUNTIME_CAPABILITY
    ))
  ) {
    throw new StructuredAgentSessionCapabilityError(
      translate(
        'components.native-chat.rewindServerUpdateRequired',
        'Rewinding requires a newer Orca server. Update the server and try again.'
      )
    )
  }
  if (
    method === 'agentSession.create' &&
    params &&
    typeof params === 'object' &&
    'forkFrom' in params &&
    !(await structuredAgentSessionForkAvailable(target))
  ) {
    throw new StructuredAgentSessionCapabilityError(
      translate(
        'components.native-chat.forkServerUpdateRequired',
        'Forking requires a newer Orca server. Update the server and try again.'
      )
    )
  }
  return method === 'agentSession.conversationCommand'
    ? callRuntimeRpc<TResult>(target, method, params, { timeoutMs: 195_000 })
    : callRuntimeRpc<TResult>(target, method, params)
}

async function subscribeStructuredAgentSessionMethod<TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!response.ok) {
      onError(response.error)
      return
    }
    onEvent(response.result as TEvent)
  }
  if (target.kind === 'local') {
    return window.api.runtime.subscribe({ method, params }, onResponse)
  }
  return window.api.runtimeEnvironments.subscribe(
    {
      selector: target.environmentId,
      method,
      params,
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(target.environmentId)
    },
    { onResponse, onError, onClose }
  )
}

export function subscribeStructuredAgentSession(
  target: RuntimeClientTarget,
  params: unknown,
  onEvent: (event: AgentSessionSubscribeEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribe',
    params,
    onEvent,
    onError,
    onClose
  )
}

/** Every structured session's projected status on one runtime, as the host publishes it. */
export function subscribeStructuredAgentSessionStatus(
  target: RuntimeClientTarget,
  onEvent: (event: AgentSessionStatusEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
): Promise<{ unsubscribe: () => void }> {
  return subscribeStructuredAgentSessionMethod(
    target,
    'agentSession.subscribeStatus',
    {},
    onEvent,
    onError,
    onClose
  )
}

export function structuredAgentSessionForkAvailable(target: RuntimeClientTarget): Promise<boolean> {
  return target.kind === 'local'
    ? Promise.resolve(true)
    : runtimeEnvironmentSupportsCapability(
        target.environmentId,
        AGENT_SESSION_FORK_RUNTIME_CAPABILITY
      )
}
