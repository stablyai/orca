import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'
import type { PtyDataHandlerShutdownSnapshot } from '@/components/terminal-pane/pty-shutdown-data-suspension'
import { disposeParkedTerminalWatchersForPtyIds } from '@/components/terminal-pane/terminal-parked-watcher-registry'
import {
  clearCommittedPtyShutdownSettlements,
  hasCommittedPtyShutdownSettlement,
  markCommittedPtyShutdowns,
  noteCommittedPtyShutdownSettlements,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import type { TerminalStoreGet, TerminalStoreSet } from './terminal-state'

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
  runtimeEnvironmentId,
  set,
  tabs
}: {
  exitGuardPtyIds: readonly string[]
  get: TerminalStoreGet
  keepIdentifiers: boolean
  rendererShutdownPtyIds: readonly string[]
  runtimeEnvironmentId: string | null
  set: TerminalStoreSet
  tabs: readonly TerminalTab[]
}): TerminalShutdownGuardController {
  let handlerSnapshots: PtyDataHandlerShutdownSnapshot[] = []
  let partialRendererStopSettled = false

  const markShutdownPending = (): void => {
    set((state) => {
      const pendingPtyShutdownIds = { ...state.pendingPtyShutdownIds }
      for (const ptyId of exitGuardPtyIds) {
        pendingPtyShutdownIds[ptyId] = (pendingPtyShutdownIds[ptyId] ?? 0) + 1
      }
      return {
        suppressedPtyExitIds: {
          ...state.suppressedPtyExitIds,
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        pendingPtyShutdownIds
      }
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
    const localPtyIds = rendererShutdownPtyIds.filter((ptyId) => !ptyId.startsWith('remote:'))
    const results = await Promise.allSettled(
      localPtyIds.map((ptyId) => window.api.pty.kill(ptyId, { keepHistory: keepIdentifiers }))
    )
    const stoppedPtyIds = [
      ...(runtimeEnvironmentId
        ? rendererShutdownPtyIds.filter((ptyId) => ptyId.startsWith('remote:'))
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
