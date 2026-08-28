import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  AGENT_STATUS_FACT_STREAM_RUNTIME_CAPABILITY,
  type AgentStatusFactStreamMessage
} from '../../../shared/agent-status-fact-types'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import {
  forgetAgentHookCompletionNotificationCoordinator,
  observeAgentHookCompletionForNotification
} from '@/hooks/agent-hook-completion-notifications'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from './web-runtime-session'

type AgentStatusFactCursor = { epoch: string; seq: number }
type AgentStatusFactSubscribeParams = { epoch?: string; lastSeenSeq?: number }

function toMirroredPaneKey(paneKey: string): string {
  const parsed = parsePaneKey(paneKey)
  return parsed ? makePaneKey(toWebTerminalSurfaceTabId(parsed.tabId), parsed.leafId) : paneKey
}

const cursorsByEnvironment = new Map<string, AgentStatusFactCursor>()

export function resetRemoteAgentStatusFactCursorsForTests(): void {
  cursorsByEnvironment.clear()
}

export async function subscribeRemoteAgentStatusFacts(
  environmentId: string,
  expectedEnvironmentPairingRevision: number | undefined,
  onError: (error: unknown) => void = console.warn,
  knownCapabilities?: readonly string[]
): Promise<{ unsubscribe: () => void } | null> {
  if (knownCapabilities === undefined) {
    try {
      if (
        !(await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_STATUS_FACT_STREAM_RUNTIME_CAPABILITY,
          15_000
        ))
      ) {
        return null
      }
    } catch (error) {
      onError(error)
      return null
    }
  } else if (!knownCapabilities.includes(AGENT_STATUS_FACT_STREAM_RUNTIME_CAPABILITY)) {
    return null
  }

  const existingCursor = cursorsByEnvironment.get(environmentId)
  const params: AgentStatusFactSubscribeParams = existingCursor
    ? { ...existingCursor, lastSeenSeq: existingCursor.seq }
    : {}
  let stopped = false
  let handle: { unsubscribe: () => void } | null = null
  const isCurrent = (): boolean =>
    !stopped && getRuntimeEnvironmentRevision(environmentId) === expectedEnvironmentPairingRevision

  const onResponse = (response: RuntimeRpcResponse<unknown>): void => {
    if (!isCurrent()) {
      return
    }
    if (response.ok === false) {
      onError(response.error)
      return
    }
    const message = response.result as AgentStatusFactStreamMessage
    if (message.type === 'ready') {
      const cursor = cursorsByEnvironment.get(environmentId)
      // A cold client or a journal gap intentionally seeds at the current head;
      // only an uninterrupted epoch/cursor pair is allowed to replay attention.
      if (!cursor || cursor.epoch !== message.epoch || message.gap) {
        const next = { epoch: message.epoch, seq: message.headSeq }
        cursorsByEnvironment.set(environmentId, next)
        params.epoch = next.epoch
        params.lastSeenSeq = next.seq
      }
      return
    }
    if (message.type !== 'fact') {
      return
    }
    const cursor = cursorsByEnvironment.get(environmentId)
    if (!cursor || cursor.epoch !== message.fact.epoch || message.fact.seq <= cursor.seq) {
      return
    }
    const next = { epoch: cursor.epoch, seq: message.fact.seq }
    cursorsByEnvironment.set(environmentId, next)
    params.epoch = next.epoch
    params.lastSeenSeq = next.seq
    if (message.fact.status === null) {
      forgetAgentHookCompletionNotificationCoordinator(toMirroredPaneKey(message.fact.paneKey))
      return
    }
    observeAgentHookCompletionForNotification({
      paneKey: toMirroredPaneKey(message.fact.paneKey),
      worktreeId: message.fact.worktreeId,
      authoritativeRemote: true,
      payload: {
        ...message.fact.status,
        ...(message.fact.turnCompletedAt !== undefined
          ? { turnCompletedAt: message.fact.turnCompletedAt }
          : {})
      }
    })
  }

  try {
    handle = await window.api.runtimeEnvironments.subscribe(
      {
        selector: environmentId,
        method: 'agent.status.subscribe',
        params,
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      },
      { onResponse, onError }
    )
  } catch (error) {
    if (!stopped) {
      onError(error)
    }
    return null
  }
  if (stopped) {
    handle.unsubscribe()
    return null
  }
  return {
    unsubscribe: () => {
      if (stopped) {
        return
      }
      stopped = true
      handle?.unsubscribe()
    }
  }
}
