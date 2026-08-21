import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { useAppStore } from '@/store'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from './terminal-layout-leaf-ids'
import {
  capturedPanesByTabId,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'

export type ParkableTerminalTabModel = Pick<TerminalTab, 'id' | 'ptyId'>

type ParkedPaneFallbackState = {
  terminalLayoutsByTabId: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: ReturnType<typeof useAppStore.getState>['runtimePaneTitlesByTabId']
}

export function fallbackParkedPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const rootLeafIds = collectLeafIdsInOrder(layout?.root)
  const rootlessLeafId = layout ? resolveRootlessTerminalLayoutLeafId(layout) : null
  const leafIds =
    rootLeafIds.length > 0 ? rootLeafIds : rootlessLeafId !== null ? [rootlessLeafId] : []
  if (leafIds.length === 0) {
    return []
  }
  const ptyIdsByLeafId = layout?.ptyIdsByLeafId ?? {}
  const titleSlots = Object.keys(state.runtimePaneTitlesByTabId[tab.id] ?? {})
  const reusableSlot =
    leafIds.length === 1 && titleSlots.length === 1 ? Number(titleSlots[0]) : null
  return leafIds.map((leafId, index) => ({
    ptyId: ptyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? tab.ptyId : null),
    paneId: reusableSlot ?? -(index + 1),
    leafId,
    drivesTabTitle: layout?.activeLeafId ? leafId === layout.activeLeafId : index === 0
  }))
}

export function resolveParkedTerminalPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const captured = capturedPanesByTabId.get(tab.id)
  const fallback = fallbackParkedPaneCandidates(tab, state)
  const capturedIsCurrent =
    captured !== undefined &&
    captured.panes.length > 0 &&
    (tab.ptyId === null || captured.panes.some((pane) => pane.ptyId === tab.ptyId)) &&
    (fallback.length === 0 ||
      (captured.panes.length === fallback.length &&
        fallback.every((pane) =>
          captured.panes.some(
            (candidate) => candidate.leafId === pane.leafId && candidate.ptyId === pane.ptyId
          )
        )))
  if (capturedIsCurrent) {
    return captured.panes
  }
  return fallback.map((pane) => {
    const prior = captured?.panes.find((candidate) => candidate.leafId === pane.leafId)
    return prior ? { ...pane, paneId: prior.paneId, drivesTabTitle: prior.drivesTabTitle } : pane
  })
}

export function reconcileParkedWatcherPtyIds(args: {
  currentTabPtyId: string | null
  entryTabPtyId: string | null
  paneIdByPtyId: ReadonlyMap<string, number>
  expectedPtyIds: ReadonlySet<string>
}): {
  restartAll: boolean
  addedPtyIds: string[]
  retainedPtyIds: string[]
  retiredPaneIds: number[]
} {
  const retainedPtyIds = Array.from(args.paneIdByPtyId.keys()).filter((ptyId) =>
    args.expectedPtyIds.has(ptyId)
  )
  return {
    restartAll: args.entryTabPtyId !== args.currentTabPtyId,
    addedPtyIds: Array.from(args.expectedPtyIds).filter((ptyId) => !args.paneIdByPtyId.has(ptyId)),
    retainedPtyIds,
    retiredPaneIds: Array.from(args.paneIdByPtyId)
      .filter(([ptyId]) => !args.expectedPtyIds.has(ptyId))
      .map(([, paneId]) => paneId)
  }
}
