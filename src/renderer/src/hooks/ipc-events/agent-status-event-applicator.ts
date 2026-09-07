import { isWslHookRelayConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import {
  resolveAgentStatusIdentity,
  shouldSuppressInheritedTerminalStatus
} from '../../../../shared/agent-status-identity'
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { shouldSuppressCodexAutoApprovalStatus } from '@/components/terminal-pane/codex-auto-approval-notification-suppression'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import { track } from '@/lib/telemetry'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import type { AgentStatusBatchUpdate, AgentStatusUpdate } from '@/store/slices/agent-status'
import { observeAgentHookCompletionForNotification } from '../agent-hook-completion-notifications'
import { useAppStore } from '../../store'
import {
  applyResolvedAgentTerminalTitleToTab,
  hasRuntimeBackedWorktreeAttribution,
  isAgentStatusForRecentlyClosedTab,
  resolveHookPayloadAgentType,
  shouldApplyResolvedAgentTerminalTitleToTab
} from './agent-status-routing'
import {
  createAgentStatusPaneRoutingIndex,
  resolvePaneKeyFromRoutingIndex,
  resolveWorktreeConnectionFromRoutingIndex
} from './agent-status-pane-routing-index'
import type {
  AgentStatusApplyOptions,
  AgentStatusApplyResult,
  PendingAgentStatusEvent
} from './agent-status-bridge-types'
import { normalizeAgentStatusEvent } from './normalize-agent-status-event'

export function createAgentStatusEventApplicator(args: {
  pendingAgentStatusEvents: PendingAgentStatusEvent[]
  transientClearWatermarkByConnectionId: Map<string, number>
  enqueuePendingAgentStatus: (data: AgentStatusIpcPayload, options?: { replay?: boolean }) => void
}): (data: AgentStatusIpcPayload, options?: AgentStatusApplyOptions) => AgentStatusApplyResult {
  const {
    pendingAgentStatusEvents,
    transientClearWatermarkByConnectionId,
    enqueuePendingAgentStatus
  } = args
  const applyAgentStatus = (
    data: AgentStatusIpcPayload,
    options?: AgentStatusApplyOptions
  ): AgentStatusApplyResult => {
    const store = options?.batch?.transaction.getState() ?? useAppStore.getState()
    if (!store.workspaceSessionReady) {
      return 'dropped'
    }
    if (isAgentStatusForRecentlyClosedTab(store, data.paneKey)) {
      return 'dropped'
    }
    const paneKey = resolveAgentPaneAuthorityKey(data.paneKey)
    const ownerTabId = parsePaneKey(paneKey)?.tabId ?? data.tabId
    const payload = normalizeAgentStatusEvent(data)
    if (!payload) {
      return 'dropped'
    }
    // Why: the memoized index answers the leading edge with the same first-match ownership the
    // standalone resolver produced, without its worktree x tab rescan per event.
    const routingIndex = options?.batch?.routingIndex ?? createAgentStatusPaneRoutingIndex(store)
    let {
      exists,
      title,
      identityTitle,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle
    } = resolvePaneKeyFromRoutingIndex(routingIndex, paneKey)
    const projectedTitles =
      titleUsesTabTitle && ownerTabId
        ? options?.batch?.projectedTitlesByTabId.get(ownerTabId)
        : undefined
    if (projectedTitles) {
      title = projectedTitles.title
      identityTitle = projectedTitles.identityTitle
    }
    if (!exists && data.worktreeId && hasRuntimeBackedWorktreeAttribution(data)) {
      const fallbackOwnership = resolveWorktreeConnectionFromRoutingIndex(
        routingIndex,
        data.worktreeId
      )
      if (fallbackOwnership.worktreeExists) {
        owningWorktreeId = data.worktreeId
        repoConnectionId = fallbackOwnership.repoConnectionId
        repoConnectionResolved = fallbackOwnership.repoConnectionResolved
        exists = true
      }
    }
    if (!exists) {
      if (options?.replay === true) {
        if (data.worktreeId && hasRuntimeBackedWorktreeAttribution(data)) {
          if (options?.retry !== true) {
            enqueuePendingAgentStatus(data, { replay: true })
          }
          return 'pending'
        }
        return 'dropped'
      }
      if (options?.retry !== true) {
        track('agent_hook_unattributed', { reason: 'unknown_tab_id' })
        enqueuePendingAgentStatus(data)
      }
      return 'pending'
    }
    if (options?.replay !== true && options?.retry !== true) {
      for (let index = pendingAgentStatusEvents.length - 1; index >= 0; index -= 1) {
        if (pendingAgentStatusEvents[index].data.paneKey === data.paneKey) {
          pendingAgentStatusEvents.splice(index, 1)
        }
      }
    }
    const ownershipConnectionId = isWslHookRelayConnectionId(data.connectionId)
      ? null
      : data.connectionId
    const transientClearWatermark =
      typeof data.connectionId === 'string'
        ? transientClearWatermarkByConnectionId.get(data.connectionId)
        : undefined
    if (transientClearWatermark !== undefined && data.receivedAt <= transientClearWatermark) {
      return 'dropped'
    }
    const canAcceptPendingRemoteOwnership =
      ownershipConnectionId !== undefined &&
      ownershipConnectionId !== null &&
      !repoConnectionResolved &&
      data.worktreeId !== undefined &&
      data.worktreeId === owningWorktreeId
    if (
      ownershipConnectionId !== undefined &&
      ownershipConnectionId !== repoConnectionId &&
      !canAcceptPendingRemoteOwnership
    ) {
      return 'dropped'
    }
    const existingStatus = store.agentStatusByPaneKey[paneKey]
    if (existingStatus && data.receivedAt < existingStatus.updatedAt) {
      return 'dropped'
    }
    if (data.providerSessionOnly) {
      if (!data.providerSession || data.agentType !== 'pi') {
        return 'dropped'
      }
      const providerSessionUpdate: AgentStatusBatchUpdate = {
        kind: 'providerSession',
        paneKey,
        agent: 'pi',
        providerSession: data.providerSession,
        timing: { updatedAt: data.receivedAt },
        routing: {
          tabId: ownerTabId,
          worktreeId: data.worktreeId ?? owningWorktreeId,
          ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
        },
        metadata: data.launchToken ? { launchToken: data.launchToken } : undefined
      }
      if (options?.batch) {
        return options.batch.transaction.apply(providerSessionUpdate) ? 'applied' : 'dropped'
      }
      store.recordAgentProviderSession(
        providerSessionUpdate.paneKey,
        providerSessionUpdate.agent,
        providerSessionUpdate.providerSession,
        providerSessionUpdate.timing,
        providerSessionUpdate.routing,
        providerSessionUpdate.metadata
      )
      return 'applied'
    }
    const resolvedPayload = resolveHookPayloadAgentType(payload, identityTitle ?? title)
    const statusPayload = data.orchestration
      ? { ...resolvedPayload, orchestration: data.orchestration }
      : resolvedPayload
    const statusPayloadWithTurnBoundary = data.promptInteractionKey
      ? { ...statusPayload, promptInteractionKey: data.promptInteractionKey }
      : statusPayload
    const statusPayloadWithProvenance =
      data.restoredUnconfirmed === true
        ? { ...statusPayloadWithTurnBoundary, restoredUnconfirmed: true }
        : statusPayloadWithTurnBoundary
    const statusPayloadWithObservation = data.observation
      ? { ...statusPayloadWithProvenance, observation: data.observation }
      : statusPayloadWithProvenance
    const identity = resolveAgentStatusIdentity({
      existing: existingStatus
        ? {
            agentType: existingStatus.agentType,
            state: existingStatus.state,
            updatedAt: existingStatus.updatedAt,
            restoredUnconfirmed: existingStatus.restoredUnconfirmed
          }
        : undefined,
      incoming: statusPayload.agentType,
      now: data.receivedAt
    })
    if (
      existingStatus &&
      shouldSuppressInheritedTerminalStatus({
        inheritedFromActivePane: identity.inheritedFromActivePane,
        incomingState: statusPayload.state
      })
    ) {
      return 'dropped'
    }
    if (
      shouldSuppressCodexAutoApprovalStatus(statusPayload, {
        paneKey,
        tabId: ownerTabId,
        terminalHandle: data.terminalHandle,
        launchToken: data.launchToken,
        providerSession: data.providerSession,
        existingProviderSession: existingStatus?.providerSession
      })
    ) {
      return 'dropped'
    }
    const terminalTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
    const statusWorktreeId = data.worktreeId ?? owningWorktreeId
    const update: AgentStatusUpdate = {
      paneKey,
      payload: statusPayloadWithObservation,
      terminalTitle,
      timing: {
        updatedAt: data.receivedAt,
        ...(data.evidenceObservedAt !== undefined
          ? { evidenceObservedAt: data.evidenceObservedAt }
          : {}),
        stateStartedAt: data.stateStartedAt
      },
      routing: {
        tabId: ownerTabId,
        worktreeId: statusWorktreeId,
        terminalHandle: data.terminalHandle,
        ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
      },
      metadata:
        data.providerSession || data.launchToken
          ? {
              ...(data.providerSession ? { providerSession: data.providerSession } : {}),
              ...(data.launchToken ? { launchToken: data.launchToken } : {})
            }
          : undefined
    }
    const applyPostCommitNotification = (): void => {
      if (statusWorktreeId && (options?.replay !== true || resolvedPayload.state === 'working')) {
        const notificationPayload =
          typeof data.stateStartedAt === 'number'
            ? { ...resolvedPayload, stateStartedAt: data.stateStartedAt }
            : resolvedPayload
        observeAgentHookCompletionForNotification({
          paneKey,
          worktreeId: statusWorktreeId,
          payload: notificationPayload,
          ...(options?.replay === true ? { seedOnly: true } : {})
        })
      }
    }
    if (options?.batch) {
      if (!options.batch.transaction.apply(update)) {
        return 'dropped'
      }
      options.batch.notificationEffects.push(applyPostCommitNotification)
      if (
        terminalTitle &&
        shouldApplyResolvedAgentTerminalTitleToTab(store, paneKey, title, terminalTitle)
      ) {
        const tabId = parsePaneKey(paneKey)?.tabId
        if (tabId) {
          options.batch.tabTitlesByTabId.set(tabId, terminalTitle)
          if (titleUsesTabTitle) {
            const titleChanges = !title || !isDecorativeAgentTitleFrameChange(title, terminalTitle)
            options.batch.projectedTitlesByTabId.set(tabId, {
              title: titleChanges ? terminalTitle : title,
              identityTitle: titleChanges ? terminalTitle : identityTitle
            })
          }
        }
      }
    } else {
      store.setAgentStatus(
        update.paneKey,
        update.payload,
        update.terminalTitle,
        update.timing,
        update.routing,
        update.metadata
      )
      applyResolvedAgentTerminalTitleToTab(useAppStore.getState(), paneKey, title, terminalTitle)
      applyPostCommitNotification()
    }
    return 'applied'
  }

  return applyAgentStatus
}
