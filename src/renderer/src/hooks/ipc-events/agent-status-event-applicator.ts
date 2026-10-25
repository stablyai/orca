import { isWslHookRelayConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import { pickHostTurnEnd, type AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { normalizeProgramStatusFacet } from '../../../../shared/program-status/facet'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import { track } from '@/lib/telemetry'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'
import type { AgentStatusUpdate } from '@/store/slices/agent-status'
import { observeAgentHookCompletionForNotification } from '../agent-hook-completion-notifications'
import { useAppStore } from '../../store'
import {
  applyResolvedAgentTerminalTitleToTab,
  hasRuntimeBackedWorktreeAttribution,
  isAgentStatusForRecentlyClosedTab,
  isInheritedFromActivePane,
  isSeenHostReplay,
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
import {
  normalizeAgentStatusEvent,
  normalizeAgentStatusMetadata
} from './normalize-agent-status-event'
import {
  applyProgramStatusOnlyUpdate,
  applyProviderSessionOnlyUpdate,
  foldProgramStatusIntoPendingRows
} from './agent-status-partial-updates'

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
    const authorityRestartId =
      options?.replay !== true && data.agentType === 'omp' ? data.authorityRestartId : undefined
    if (isAgentStatusForRecentlyClosedTab(store, data.paneKey, authorityRestartId)) {
      return 'dropped'
    }
    const paneKey = resolveAgentPaneAuthorityKey(data.paneKey)
    const ownerTabId = parsePaneKey(paneKey)?.tabId ?? data.tabId
    const payload = normalizeAgentStatusEvent(data)
    if (!payload) {
      return 'dropped'
    }
    const programStatus = normalizeProgramStatusFacet(data.programStatus) ?? null
    // Reuse first-match pane ownership without rescanning every worktree per event.
    const routingIndex = options?.batch?.routingIndex ?? createAgentStatusPaneRoutingIndex(store)
    let {
      exists,
      title,
      identityTitle,
      repoConnectionId,
      repoConnectionResolved,
      owningWorktreeId,
      titleUsesTabTitle,
      tabTitle
    } = resolvePaneKeyFromRoutingIndex(routingIndex, paneKey)
    const projectedTitles =
      titleUsesTabTitle && ownerTabId
        ? options?.batch?.projectedTitlesByTabId.get(ownerTabId)
        : undefined
    if (projectedTitles) {
      title = projectedTitles.title
      identityTitle = projectedTitles.identityTitle
    }
    tabTitle = options?.batch?.tabTitlesByTabId.get(ownerTabId ?? '') ?? tabTitle
    if (
      !exists &&
      !authorityRestartId &&
      data.worktreeId &&
      hasRuntimeBackedWorktreeAttribution(data)
    ) {
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
      if (data.programStatusOnly === true) {
        // Why not pend: progress ticks would crowd real rows out of the bounded queue.
        foldProgramStatusIntoPendingRows(pendingAgentStatusEvents, data.paneKey, programStatus)
        return 'dropped'
      }
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
    // A facet tick does not supersede a pending state row for the pane.
    if (options?.replay !== true && options?.retry !== true && data.programStatusOnly !== true) {
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
    if (data.programStatusOnly === true) {
      // Why after ownership but before staleness: the republished row keeps its old receivedAt.
      return applyProgramStatusOnlyUpdate(store, options?.batch, paneKey, programStatus)
    }
    if (existingStatus && data.receivedAt < existingStatus.updatedAt) {
      return 'dropped'
    }
    if (data.providerSessionOnly) {
      return applyProviderSessionOnlyUpdate({
        store,
        batch: options?.batch,
        data,
        paneKey,
        routing: {
          tabId: ownerTabId,
          worktreeId: data.worktreeId ?? owningWorktreeId,
          ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
        }
      })
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
    // Why null: main stitches the pane's current facet onto every publish, so absence means cleared.
    const statusPayloadWithProgramStatus = { ...statusPayloadWithObservation, programStatus }
    if (
      existingStatus &&
      isInheritedFromActivePane(existingStatus, data, statusPayload.agentType, {
        connectionId: ownershipConnectionId,
        worktreeId: owningWorktreeId
      })
    ) {
      return 'dropped'
    }
    const terminalTitle = resolveAgentStatusTerminalTitle(statusPayload, title)
    const statusWorktreeId = data.worktreeId ?? owningWorktreeId
    const update: AgentStatusUpdate = {
      paneKey,
      payload: statusPayloadWithProgramStatus,
      terminalTitle,
      timing: {
        updatedAt: data.receivedAt,
        ...(data.evidenceObservedAt !== undefined
          ? { evidenceObservedAt: data.evidenceObservedAt }
          : {}),
        stateStartedAt: data.stateStartedAt,
        ...(Number.isFinite(data.turnStartedAt) ? { turnStartedAt: data.turnStartedAt } : {}),
        ...pickHostTurnEnd(data)
      },
      routing: {
        tabId: ownerTabId,
        worktreeId: statusWorktreeId,
        terminalHandle: data.terminalHandle,
        ...(ownershipConnectionId !== undefined ? { connectionId: ownershipConnectionId } : {})
      },
      metadata: normalizeAgentStatusMetadata(data, authorityRestartId)
    }
    // Why: replays are cached state, so they seed completion tracking unless they carry an unseen completion.
    const replayed =
      options?.replay === true || isSeenHostReplay(data, resolvedPayload.state, existingStatus)
    const applyPostCommitNotification = (): void => {
      if (statusWorktreeId && (!replayed || resolvedPayload.state === 'working')) {
        const notificationPayload = {
          ...resolvedPayload,
          stateStartedAt: data.stateStartedAt,
          ...pickHostTurnEnd(data)
        }
        observeAgentHookCompletionForNotification({
          paneKey,
          worktreeId: statusWorktreeId,
          payload: notificationPayload,
          ...(replayed ? { seedOnly: true } : {})
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
        shouldApplyResolvedAgentTerminalTitleToTab(store, paneKey, tabTitle, terminalTitle)
      ) {
        if (ownerTabId) {
          options.batch.tabTitlesByTabId.set(ownerTabId, terminalTitle)
          if (titleUsesTabTitle) {
            const titleChanges = !title || !isDecorativeAgentTitleFrameChange(title, terminalTitle)
            options.batch.projectedTitlesByTabId.set(ownerTabId, {
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
      applyResolvedAgentTerminalTitleToTab(useAppStore.getState(), paneKey, tabTitle, terminalTitle)
      applyPostCommitNotification()
    }
    return 'applied'
  }

  return applyAgentStatus
}
