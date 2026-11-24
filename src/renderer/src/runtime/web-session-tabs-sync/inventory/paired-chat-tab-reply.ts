import { useAppStore } from '@/store'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { hostSnapshotAffirmsWorktreeContents } from '../../../../../shared/remote-runtime/session-graph/host-session-snapshot-authority'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { structuredAgentSessionOwnerForTab } from '../../native-chat/session-ownership/structured-agent-session-owner'
import { createRuntimeRpcAbortError } from '../../rpc/calls/abortable-runtime-environment-call'
import { callRuntimeRpcResponse } from '../../rpc/calls/runtime-rpc-call'
import { getRuntimeEnvironmentRegistration } from '../../rpc/environment-revisions/runtime-environment-revision'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { isWebSessionCloseIntentPending } from '../closing/web-session-close-intent'
import { isServerFrameDrawnWorkspace } from '../frame-drawn/frame-drawn-server-workspace-set'
import { recordHostSessionTabIdMapping } from '../identity/tracking-mappings'
import { chooseTargetGroupId } from '../placement/tab-group-layout-tree'
import {
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  sessionTabsFreshnessKey
} from '../state'
import { buildMirroredAgentTabs } from '../tab-projection/terminal-surfaces'
import { recordDirectlyOpenedChat } from '../tracking/directly-opened-chat-tabs'
import { getSessionTabsRuntimeIdFromResponse } from '../tracking/publisher-identity-fences'
import { isWebSessionTabsWorktreeRemovalFrame } from '../tracking/session-tabs-inventory-absence'
import { canProjectWebSessionTabsRead } from '../tracking/tracking'
import { waitForChatLinkSessionTabs } from './remote-runtime-session-tabs-inflight'

/** Materialize one listed chat before its subscription frame arrives. */
export async function readPairedChatTab(args: {
  environmentId: string
  worktreeId: string
  sessionId: string
  timeoutMs: number
  minimumReceivedFrame?: number
  signal: AbortSignal
  current: () => boolean
}): Promise<void> {
  const { environmentId, worktreeId, sessionId, current, signal } = args
  if (signal.aborted || !current()) {
    return
  }
  const registration = getRuntimeEnvironmentRegistration(environmentId)
  const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const isSameConnection = (): boolean =>
    getRuntimeEnvironmentRegistration(environmentId) === registration &&
    getRuntimeEnvironmentConnectionGeneration(environmentId) === connectionGeneration
  const { snapshot, receivedFrame, runtimeId } = await waitForChatLinkSessionTabs({
    environmentId,
    worktreeId,
    scope: { registration, connectionGeneration, timeoutMs: args.timeoutMs },
    minimumReceivedFrame: args.minimumReceivedFrame,
    signal,
    load: async (hasWaiters) => {
      const beforeSend = (): void => {
        if (!isSameConnection() || !hasWaiters()) {
          throw createRuntimeRpcAbortError()
        }
      }
      beforeSend()
      const response = await callRuntimeRpcResponse<RuntimeMobileSessionTabsResult>(
        { kind: 'environment', environmentId },
        'session.tabs.list',
        { worktree: toRuntimeWorktreeSelector(worktreeId) },
        {
          timeoutMs: args.timeoutMs,
          beforeSend,
          expectedEnvironmentPairingRevision: registration?.revision
        }
      )
      return { snapshot: response.result, runtimeId: getSessionTabsRuntimeIdFromResponse(response) }
    }
  })
  if (
    signal.aborted ||
    !current() ||
    !isSameConnection() ||
    snapshot?.worktree !== worktreeId ||
    isWebSessionTabsWorktreeRemovalFrame(snapshot) ||
    !hostSnapshotAffirmsWorktreeContents(snapshot) ||
    !canProjectWebSessionTabsRead(environmentId, snapshot, receivedFrame, runtimeId) ||
    isServerFrameDrawnWorkspace(environmentId, worktreeId)
  ) {
    return
  }

  const key = sessionTabsFreshnessKey(environmentId, worktreeId)
  const applied = latestSessionTabsSnapshotByWorktree.get(key)
  if (
    applied?.publicationEpoch === snapshot.publicationEpoch &&
    applied.snapshotVersion > snapshot.snapshotVersion
  ) {
    return
  }
  const chat = snapshot.tabs?.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === sessionId
  )
  const now = Date.now()
  const closeOwner = { environmentId, pairingRevision: registration?.revision }
  if (
    !chat ||
    chat.type !== 'agent-session' ||
    isWebSessionCloseIntentPending(closeOwner, worktreeId, chat.id, now) ||
    isWebSessionCloseIntentPending(closeOwner, worktreeId, `agent-session:${sessionId}`, now)
  ) {
    return
  }
  const state = useAppStore.getState()
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const currentTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const isOwnerTab = (tab: (typeof currentTabs)[number]) =>
    structuredAgentSessionOwnerForTab(state, tab) === executionHostId
  if (
    currentTabs.some(
      (tab) =>
        tab.contentType === 'agent-session' &&
        isOwnerTab(tab) &&
        (tab.entityId === sessionId || tab.entityId === chat.replacesSessionId)
    )
  ) {
    return
  }
  const existingGroup = snapshot.tabGroups?.find((group) => group.tabOrder.includes(chat.id))
  const [mirror] = buildMirroredAgentTabs(
    { ...snapshot, tabs: [chat] },
    executionHostId,
    new Map(),
    chooseTargetGroupId(state, {
      ...snapshot,
      activeGroupId: existingGroup?.id ?? snapshot.activeGroupId
    }),
    currentTabs.length,
    currentTabs,
    now,
    { mayAdopt: isOwnerTab }
  )
  if (!mirror) {
    return
  }
  const tab = state.createUnifiedTab(worktreeId, 'agent-session', {
    ...mirror.unifiedTab,
    targetGroupId: mirror.unifiedTab.groupId,
    activate: false,
    recordInteraction: false
  })
  recordHostSessionTabIdMapping(
    { environmentId, worktreeId, tabId: tab.id },
    chat.id,
    existingGroup?.id
  )
  const previousEpoch = latestReceivedSessionTabsSnapshotByWorktree.get(key)?.publicationEpoch
  const initialGroupId = state.groupsByWorktree[worktreeId]?.length ? undefined : tab.groupId
  recordDirectlyOpenedChat(environmentId, worktreeId, sessionId, {
    tabId: tab.id,
    hostTabId: chat.id,
    hostGroupId: existingGroup?.id,
    registration,
    connectionGeneration,
    runtimeId,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion,
    previousEpoch,
    initialGroupId
  })
}
