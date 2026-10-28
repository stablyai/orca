import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { agentChildWorkLiveness } from '../../../../shared/agent-status-child-work-liveness'
import type {
  AgentSessionStatusSummary,
  AgentSessionHistoryResult
} from '../../../../shared/agent-session-wire'
import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import type { StructuredAgentSessionAdmission } from '@/components/native-chat/structured-agent-session-read-owner-contract'

function summaryBusy(summary: AgentSessionStatusSummary | null | undefined): boolean {
  return (
    summary?.status !== 'idle' ||
    summary.hostExecutionPhase === 'starting' ||
    agentChildWorkLiveness(summary.children ?? summary.backgroundTasks) !== null
  )
}

export function admitStructuredAgentSession(
  workspaceId: string,
  tab: Tab,
  intent: string,
  effect: (busy: boolean, attempt: StructuredAgentSessionAdmission) => void | Promise<void>
): Promise<void> {
  const target = structuredAgentSessionTargetForHost(tab.executionHostId)
  const owner = getStructuredAgentSessionReadOwner(tab.entityId, target, tab.executionHostId ?? '')
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const pairing = (): number | undefined =>
    environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const runtime = (): string | undefined =>
    environmentId
      ? useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status?.runtimeId
      : undefined
  const identity = (item: Tab | undefined) => [
    item?.worktreeId,
    item?.contentType,
    item?.entityId,
    item?.executionHostId,
    pairing(),
    runtime()
  ]
  const captured = identity(tab)
  const valid = (): boolean =>
    identity(
      useAppStore.getState().unifiedTabsByWorktree[workspaceId]?.find((item) => item.id === tab.id)
    ).every((value, index) => value === captured[index])
  const localBusy = (): boolean | undefined => {
    const state = useAppStore.getState()
    const status =
      state.agentStatusByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)]?.state
    const launch = getStructuredAgentSessionLaunchLifecycle(workspaceId, tab.entityId)
    const feed = target && getStructuredAgentSessionStatusFeed(target)
    const summary = feed?.getSnapshot().get(tab.entityId)
    if (
      (status && status !== 'done') ||
      launch === 'pending' ||
      launch === 'visibility-unknown' ||
      getStructuredAgentSessionPendingSends(tab.entityId).some(
        (entry) => entry.phase === 'sending'
      ) ||
      summary?.hostExecutionPhase === 'starting' ||
      (summary?.status && summaryBusy(summary))
    ) {
      return true
    }
    if (launch === 'failed' && !summary && target) {
      return false
    }
    return !feed || feed.getSessionObservation(tab.entityId) !== 'live' ? true : undefined
  }
  const read = async (signal: AbortSignal, deadline: number): Promise<boolean> => {
    if (!target) {
      return true
    }
    const result = await callRuntimeRpc<AgentSessionHistoryResult>(
      target,
      'agentSession.history',
      { sessionId: tab.entityId, direction: 'tail', limit: 1 },
      {
        signal,
        timeoutMs: 2_000,
        expectedEnvironmentPairingRevision: pairing(),
        expectedEnvironmentRuntimeId: runtime()
      }
    )
    const page = result.page
    if (
      !result.ok ||
      signal.aborted ||
      Date.now() >= deadline ||
      page.hasNewer ||
      page.backgroundTasks != null ||
      page.nextQueuedMessageId != null ||
      page.latestTurn?.turn.state === 'running' ||
      page.latestTurn?.turn.state === 'unverifiable'
    ) {
      return true
    }
    return (
      page.working !== false ||
      page.actionablePromptIds?.length !== 0 ||
      page.latestTurn === undefined ||
      page.nextQueuedMessageId === undefined ||
      page.backgroundTasks === undefined
    )
  }
  return owner.admit(`${tab.id}:${intent}`, valid, (attempt) => {
    const deadline = Date.now() + 2_000
    const apply = (busy: boolean): void | Promise<void> => {
      if (Date.now() >= deadline) {
        busy = true
      }
      if (attempt.current()) {
        return effect(busy || attempt.busy() || localBusy() === true, attempt)
      }
    }
    const local = attempt.busy() ? true : localBusy()
    if (local !== undefined) {
      return apply(local)
    }
    const query = new AbortController()
    return sharedPromiseSettlementWaiters(read(query.signal, deadline))
      .wait({
        signal: attempt.signal,
        timeoutMs: Math.max(0, deadline - Date.now())
      })
      .finally(() => query.abort())
      .then(apply, () => apply(true))
  })
}
