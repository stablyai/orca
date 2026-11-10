import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { PaneSleepStopCondition } from '../../../../shared/agent-session/lifecycle/pane-sleep-target'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import '@/components/terminal-pane/pty-transport/delivery/pty-dispatcher'
import {
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers,
  type PtyDataHandlerShutdownSnapshot
} from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension'

import { disposeParkedTerminalWatchersForPtyIds } from '@/components/terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import {
  clearCommittedPtyShutdownSettlements,
  hasCommittedPtyShutdownSettlement,
  markCommittedPtyShutdowns,
  noteCommittedPtyShutdownSettlements,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-exit-deferral'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { copyOnWriteRecord } from './terminal-shutdown-record'

export type TerminalShutdownGuardController = {
  commitHandlerSnapshots: () => void
  markShutdownPending: () => void
  rollbackShutdown: () => void
  settlePartialRendererStop: (stoppedPtyIds: readonly string[]) => void
  stopRendererPtys: () => Promise<{
    stoppedPtyIds: string[]
    failure?: PromiseRejectedResult
  }>
  unregisterHandlers: () => void
  wasPartialRendererStopSettled: () => boolean
}

export function createTerminalShutdownGuardController({
  exitGuardPtyIds,
  get,
  keepIdentifiers,
  rendererShutdownPtyIds,
  runtimeOwnsRemotePtys,
  set,
  tabs,
  sleepConditionForPty,
  guardSleepTargets
}: {
  exitGuardPtyIds: readonly string[]
  get: TerminalStoreGet
  keepIdentifiers: boolean
  rendererShutdownPtyIds: readonly string[]
  /** A runtime host stops the `remote:` PTYs, so the renderer counts them stopped. */
  runtimeOwnsRemotePtys: boolean
  set: TerminalStoreSet
  tabs: readonly TerminalTab[]
  guardSleepTargets?: boolean
  sleepConditionForPty?: (ptyId: string) => PaneSleepStopCondition | undefined
}): TerminalShutdownGuardController {
  let handlerSnapshots: PtyDataHandlerShutdownSnapshot[] = []
  let partialRendererStopSettled = false

  const markShutdownPending = (): void => {
    // Already-exited workspaces have no guard IDs; skip spreads that would churn both map identities.
    if (exitGuardPtyIds.length === 0) {
      return
    }
    set((state) => {
      const pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
      // Why copy-on-write: re-guarding an already-suppressed pty writes the same `true`.
      const suppressedPtyExitIds = copyOnWriteRecord(state.suppressedPtyExitIds)
      for (const ptyId of exitGuardPtyIds) {
        pendingPtyShutdownIds[ptyId] = (pendingPtyShutdownIds[ptyId] ?? 0) + 1
        if (state.suppressedPtyExitIds[ptyId] !== true) {
          suppressedPtyExitIds.set(ptyId, true)
        }
      }
      return { suppressedPtyExitIds: suppressedPtyExitIds.read(), pendingPtyShutdownIds }
    })
  }

  const settleGuards = (
    stoppedPtyIds: ReadonlySet<string>,
    clearStoppedTabBindings = false
  ): void => {
    set((state) => {
      const pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
      const suppressedPtyExitIds = { ...state.suppressedPtyExitIds }
      for (const ptyId of exitGuardPtyIds) {
        const remainingOwners = (pendingPtyShutdownIds[ptyId] ?? 0) - 1
        if (remainingOwners > 0) {
          pendingPtyShutdownIds[ptyId] = remainingOwners
        } else {
          delete pendingPtyShutdownIds[ptyId]
          if (!stoppedPtyIds.has(ptyId)) {
            delete suppressedPtyExitIds[ptyId]
          }
        }
      }
      if (!clearStoppedTabBindings) {
        return { pendingPtyShutdownIds, suppressedPtyExitIds }
      }
      const ptyIdsByTabId = { ...state.ptyIdsByTabId }
      for (const tab of tabs) {
        ptyIdsByTabId[tab.id] = (state.ptyIdsByTabId[tab.id] ?? []).filter(
          (ptyId) => !stoppedPtyIds.has(ptyId)
        )
      }
      return { ptyIdsByTabId, pendingPtyShutdownIds, suppressedPtyExitIds }
    })
  }

  const rollbackShutdown = (): void => {
    if (handlerSnapshots.length > 0) {
      restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
    }
    set((state) => {
      const suppressedPtyExitIds = { ...state.suppressedPtyExitIds }
      const pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
      for (const ptyId of exitGuardPtyIds) {
        const remainingOwners = (pendingPtyShutdownIds[ptyId] ?? 0) - 1
        if (remainingOwners > 0) {
          pendingPtyShutdownIds[ptyId] = remainingOwners
        } else {
          delete pendingPtyShutdownIds[ptyId]
          if (!hasCommittedPtyShutdownSettlement(ptyId)) {
            delete suppressedPtyExitIds[ptyId]
          }
        }
      }
      return { suppressedPtyExitIds, pendingPtyShutdownIds }
    })
    const settledPtyIds = exitGuardPtyIds.filter((ptyId) => !get().isPtyShutdownPending(ptyId))
    const committedPtyIds = settledPtyIds.filter(hasCommittedPtyShutdownSettlement)
    const rolledBackPtyIds = settledPtyIds.filter(
      (ptyId) => !hasCommittedPtyShutdownSettlement(ptyId)
    )
    markCommittedPtyShutdowns(committedPtyIds)
    settleDeferredPtyShutdownExits(committedPtyIds, 'committed')
    settleDeferredPtyShutdownExits(rolledBackPtyIds, 'rolled-back')
    clearCommittedPtyShutdownSettlements(settledPtyIds)
  }

  const stopRendererPtys = async (): Promise<{
    stoppedPtyIds: string[]
    failure?: PromiseRejectedResult
  }> => {
    const localPtyIds = rendererShutdownPtyIds.filter((ptyId) => !isRemoteRuntimePtyId(ptyId))
    const results = await Promise.allSettled(
      localPtyIds.map(async (ptyId) => {
        let condition = sleepConditionForPty?.(ptyId)
        if (guardSleepTargets && !condition) {
          const state = get()
          const tab = tabs.find((candidate) => state.ptyIdsByTabId[candidate.id]?.includes(ptyId))
          const leafId =
            tab &&
            Object.entries(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).find(
              ([, id]) => id === ptyId
            )?.[0]
          const paneKey = tab && leafId ? `${tab.id}:${leafId}` : null
          if (!tab || !paneKey || !parsePaneKey(paneKey)) {
            throw new Error('sleep_target_changed')
          }
          const source = state.agentStatusByPaneKey[paneKey]
          const observation = (await window.api.pty.inspectProcess(ptyId, { foregroundOnly: true }))
            ?.foregroundObservation
          if (
            observation?.verdict !== 'observed' ||
            observation.ptyId !== ptyId ||
            get().agentStatusByPaneKey[paneKey] !== source ||
            get().terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId?.[leafId!] !== ptyId
          ) {
            throw new Error('sleep_target_changed')
          }
          condition = {
            workspace: tab.worktreeId,
            target: {
              paneKey,
              ptyId,
              ptyIncarnationId: observation.ptyIncarnationId,
              authorityGeneration: observation.authorityGeneration,
              sourceUpdatedAt: source?.updatedAt
            }
          }
        }
        await window.api.pty.kill(ptyId, {
          keepHistory: keepIdentifiers,
          ...(condition ? { sleepCondition: condition } : {})
        })
      })
    )
    const stoppedPtyIds = [
      ...(runtimeOwnsRemotePtys
        ? rendererShutdownPtyIds.filter((ptyId) => isRemoteRuntimePtyId(ptyId))
        : []),
      ...localPtyIds.filter((_, index) => results[index]?.status === 'fulfilled')
    ]
    disposeParkedTerminalWatchersForPtyIds(stoppedPtyIds)
    return {
      stoppedPtyIds,
      failure: results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
    }
  }

  const settlePartialRendererStop = (stoppedPtyIds: readonly string[]): void => {
    partialRendererStopSettled = true
    const stopped = new Set(stoppedPtyIds)
    const stoppedSnapshots = handlerSnapshots.filter((snapshot) => stopped.has(snapshot.ptyId))
    const failedSnapshots = handlerSnapshots.filter((snapshot) => !stopped.has(snapshot.ptyId))
    for (const snapshot of stoppedSnapshots) {
      snapshot.commit?.()
    }
    restorePtyDataHandlersAfterFailedShutdown(failedSnapshots)
    noteCommittedPtyShutdownSettlements(stoppedPtyIds)
    settleGuards(stopped, true)
    const failedPtyIds = exitGuardPtyIds.filter((ptyId) => !stopped.has(ptyId))
    markCommittedPtyShutdowns(stoppedPtyIds)
    settleDeferredPtyShutdownExits(stoppedPtyIds, 'committed')
    settleDeferredPtyShutdownExits(failedPtyIds, 'rolled-back')
    clearCommittedPtyShutdownSettlements(exitGuardPtyIds)
  }

  return {
    commitHandlerSnapshots: () => {
      for (const snapshot of handlerSnapshots) {
        snapshot.commit?.()
      }
      noteCommittedPtyShutdownSettlements(exitGuardPtyIds)
    },
    markShutdownPending,
    rollbackShutdown,
    settlePartialRendererStop,
    stopRendererPtys,
    unregisterHandlers: () => {
      handlerSnapshots = unregisterPtyDataHandlers([...rendererShutdownPtyIds]) ?? []
    },
    wasPartialRendererStopSettled: () => partialRendererStopSettled
  }
}
