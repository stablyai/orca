import type { AppState } from '../../store'
import { useAppStore } from '../../store'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { pickParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import { normalizeTurnCompletedAtField } from '../../../../shared/agent-status-field-normalization'
import { isClientAuthoritativeAgentStatusPane } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { observeAgentHookCompletionForNotification } from '@/hooks/agent-hook-completion-notifications'
import { remapHostAgentStatus } from './agent-status-primitives'
import { agentStatusEntryEqual } from './state-equality-core'
import {
  HOST_WORKING_CLIENT_BOUNDARY_LIMIT,
  hostWorkingClientBoundaryByPaneKey,
  type WebSessionTabsSyncState
} from './state'
import {
  createHostSessionMirrorSettle,
  type HostSessionMirrorPatchVerdict,
  type HostSessionMirrorSettle
} from './mirror-settle'

/** Commit a reconciliation patch and return a receipt for its host evidence. */
export function applyWebSessionTabsStorePatch(
  buildPatch: (state: AppState) => WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  hostMirrorVerdict: HostSessionMirrorPatchVerdict,
  agentStatusSnapshots?: RuntimeMobileSessionTabsResult | readonly RuntimeMobileSessionTabsResult[],
  allowCompletionNotification = false
): HostSessionMirrorSettle {
  let mirroredAgentStatusChanged = false
  // Zustand commits before notifying subscribers, so a completed producer has landed even if a subscriber throws.
  let patchCommitted = false
  const acceptedNotificationStatuses: {
    paneKey: string
    worktreeId: string
    seedOnly?: true
    payload: ReturnType<typeof pickParsedAgentStatusPayload> & {
      stateStartedAt: number
      localStateStartedAt?: number
    }
  }[] = []

  const runStorePatch = (
    state: AppState
  ): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> => {
    const patch = buildPatch(state)
    mirroredAgentStatusChanged = patch !== state && Object.hasOwn(patch, 'agentStatusByPaneKey')
    if (agentStatusSnapshots) {
      const nextAgentStatuses = patch.agentStatusByPaneKey ?? state.agentStatusByPaneKey
      const snapshots = Array.isArray(agentStatusSnapshots)
        ? agentStatusSnapshots
        : [agentStatusSnapshots]
      for (const snapshot of snapshots) {
        for (const surface of snapshot.tabs) {
          if (surface.type !== 'terminal') {
            continue
          }
          const remapped = remapHostAgentStatus(surface)
          const accepted = remapped ? nextAgentStatuses[remapped.paneKey] : undefined
          const turnCompletedAt = remapped
            ? normalizeTurnCompletedAtField(surface.turnCompletedAt, remapped.state)
            : undefined
          if (remapped?.state === 'done' && turnCompletedAt === undefined) {
            hostWorkingClientBoundaryByPaneKey.delete(remapped.paneKey)
          }
          // Client OSC owns display state; the host hook stream carries background-turn stamps.
          const clientOwnedNotification = Boolean(
            remapped &&
            isClientAuthoritativeAgentStatusPane(remapped.paneKey) &&
            (remapped.state === 'working' || turnCompletedAt !== undefined)
          )
          if (
            !remapped ||
            (!clientOwnedNotification &&
              (!accepted ||
                accepted === state.agentStatusByPaneKey[remapped.paneKey] ||
                !agentStatusEntryEqual(accepted, remapped)))
          ) {
            continue
          }
          const notificationStatus = clientOwnedNotification ? remapped : accepted
          if (!notificationStatus) {
            continue
          }
          const currentClientStateStartedAt = clientOwnedNotification
            ? state.agentStatusByPaneKey[notificationStatus.paneKey]?.stateStartedAt
            : undefined
          let localStateStartedAt = currentClientStateStartedAt
          if (
            clientOwnedNotification &&
            notificationStatus.state === 'working' &&
            currentClientStateStartedAt !== undefined
          ) {
            if (turnCompletedAt === undefined) {
              const retainedBoundary = hostWorkingClientBoundaryByPaneKey.get(
                notificationStatus.paneKey
              )
              if (
                !retainedBoundary ||
                retainedBoundary.hostStateStartedAt !== notificationStatus.stateStartedAt ||
                retainedBoundary.hostPrompt !== notificationStatus.prompt ||
                retainedBoundary.stamped
              ) {
                hostWorkingClientBoundaryByPaneKey.delete(notificationStatus.paneKey)
                hostWorkingClientBoundaryByPaneKey.set(notificationStatus.paneKey, {
                  hostStateStartedAt: notificationStatus.stateStartedAt,
                  hostPrompt: notificationStatus.prompt,
                  clientStateStartedAt: currentClientStateStartedAt,
                  stamped: false
                })
                if (hostWorkingClientBoundaryByPaneKey.size > HOST_WORKING_CLIENT_BOUNDARY_LIMIT) {
                  const oldestPaneKey = hostWorkingClientBoundaryByPaneKey.keys().next().value
                  if (oldestPaneKey !== undefined) {
                    hostWorkingClientBoundaryByPaneKey.delete(oldestPaneKey)
                  }
                }
              }
            } else {
              const retainedBoundary = hostWorkingClientBoundaryByPaneKey.get(
                notificationStatus.paneKey
              )
              if (
                retainedBoundary?.hostStateStartedAt === notificationStatus.stateStartedAt &&
                retainedBoundary.hostPrompt === notificationStatus.prompt
              ) {
                localStateStartedAt = retainedBoundary.clientStateStartedAt
                retainedBoundary.stamped = true
              }
            }
          }
          if (!allowCompletionNotification && notificationStatus.state !== 'working') {
            continue
          }
          acceptedNotificationStatuses.push({
            paneKey: notificationStatus.paneKey,
            worktreeId: notificationStatus.worktreeId ?? snapshot.worktree,
            ...(!allowCompletionNotification ? { seedOnly: true as const } : {}),
            payload: {
              ...pickParsedAgentStatusPayload({
                ...notificationStatus,
                ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {})
              }),
              stateStartedAt: notificationStatus.stateStartedAt,
              ...(clientOwnedNotification ? { localStateStartedAt } : {})
            }
          })
        }
      }
    }
    patchCommitted = true
    return patch
  }

  try {
    useAppStore.setState(runStorePatch)
  } catch (error) {
    if (!patchCommitted) {
      throw error
    }
    console.warn('[web-session-tabs-sync] a store subscriber failed after the patch landed:', error)
  }

  const settleHostMirror = createHostSessionMirrorSettle(hostMirrorVerdict)
  try {
    if (mirroredAgentStatusChanged) {
      useAppStore.getState().scheduleAgentStatusFreshness()
    }
    for (const status of acceptedNotificationStatuses) {
      observeAgentHookCompletionForNotification(status)
    }
  } catch (error) {
    console.warn('[web-session-tabs-sync] post-patch bookkeeping failed:', error)
  }
  return settleHostMirror
}
