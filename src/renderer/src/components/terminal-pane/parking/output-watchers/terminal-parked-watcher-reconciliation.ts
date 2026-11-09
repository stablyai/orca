import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { useAppStore } from '@/store/index'
import { collectLeafIdsInOrder } from '../../layout/terminal-layout-leaf-traversal'
import { resolveRootlessTerminalLayoutLeafId } from '../../../../../../shared/workspace-layout/terminal-pane-tree'
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

function leafPtyKey(leafId: string, ptyId: string | null): string {
  return `${leafId}\u0000${ptyId ?? ''}\u0000${ptyId === null ? 0 : 1}`
}

// Index captured panes so a many-split tab stays linear in its pane count.
function capturedCoversFallback(
  captured: readonly ParkedTerminalPaneCapture[],
  fallback: readonly ParkedTerminalPaneCapture[]
): boolean {
  const capturedLeafPtyKeys = new Set(
    captured.map((candidate) => leafPtyKey(candidate.leafId, candidate.ptyId))
  )
  return fallback.every((pane) => capturedLeafPtyKeys.has(leafPtyKey(pane.leafId, pane.ptyId)))
}

export function resolveParkedTerminalPaneCandidates(
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const captured = capturedPanesByTabId.get(tab.id)
  const fallback = fallbackParkedPaneCandidates(tab, state)
  if (!captured) {
    return fallback
  }
  const capturedIsCurrent =
    captured.panes.length > 0 &&
    (tab.ptyId === null || captured.panes.some((pane) => pane.ptyId === tab.ptyId)) &&
    (fallback.length === 0 ||
      (captured.panes.length === fallback.length &&
        capturedCoversFallback(captured.panes, fallback)))
  if (capturedIsCurrent) {
    return captured.panes
  }
  if (fallback.length === 0) {
    return fallback
  }
  const priorByLeafId = new Map<string, ParkedTerminalPaneCapture>()
  for (const candidate of captured.panes) {
    if (!priorByLeafId.has(candidate.leafId)) {
      priorByLeafId.set(candidate.leafId, candidate)
    }
  }
  return fallback.map((pane) => {
    const prior = priorByLeafId.get(pane.leafId)
    return prior
      ? {
          ...pane,
          paneId: prior.paneId,
          ...(prior.ptyId === pane.ptyId && prior.workspaceOwner
            ? { workspaceOwner: prior.workspaceOwner }
            : {}),
          drivesTabTitle: prior.drivesTabTitle,
          // Why: the fact belongs to the captured PTY; a re-minted id on this leaf is a different shell.
          ...(prior.ptyId === pane.ptyId && prior.untouchedFreshSpawn
            ? { untouchedFreshSpawn: true }
            : {})
        }
      : pane
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
