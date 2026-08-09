import type { TerminalTab } from '../../../../shared/types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import {
  collectLeafIdsInOrder,
  resolveRootlessTerminalLayoutLeafId
} from './terminal-layout-leaf-ids'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId,
  type ParkedTabWatcherEntry,
  type ParkedTerminalPaneCapture
} from './terminal-parked-watcher-registry'
import {
  isParkRestorableTerminalPty,
  selectPairedRuntimeParkingEnvironmentIds,
  type TerminalParkRestorePolicy
} from './terminal-hidden-view-parking'
import { startParkedPtyWatcher } from './terminal-parked-pty-watcher'

export type ParkableTerminalTabModel = Pick<TerminalTab, 'id' | 'ptyId' | 'generation'>
export type ParkedTerminalPaneMaterialBinding = Pick<ParkedTerminalPaneCapture, 'leafId' | 'ptyId'>

type ParkedPaneFallbackState = {
  terminalLayoutsByTabId: ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
  runtimePaneTitlesByTabId: ReturnType<typeof useAppStore.getState>['runtimePaneTitlesByTabId']
}

type ParkedPaneTopologyState = Pick<ParkedPaneFallbackState, 'terminalLayoutsByTabId'> &
  Partial<Pick<ParkedPaneFallbackState, 'runtimePaneTitlesByTabId'>>

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
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneCapture[] {
  const captured = capturedPanesByTabId.get(tab.id)
  const fallback = fallbackParkedPaneCandidates(tab, state)
  const capturedHasCurrentIdentity =
    captured !== undefined &&
    captured.worktreeId === worktreeId &&
    captured.generation === (tab.generation ?? null)
  const capturedIsCurrent =
    capturedHasCurrentIdentity &&
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
    return captured.panes.map((pane) => {
      const current = fallback.find(
        (candidate) => candidate.leafId === pane.leafId && candidate.ptyId === pane.ptyId
      )
      return current ? { ...pane, drivesTabTitle: current.drivesTabTitle } : pane
    })
  }
  return fallback.map((pane) => {
    const prior = capturedHasCurrentIdentity
      ? captured.panes.find((candidate) => candidate.leafId === pane.leafId)
      : undefined
    return prior ? { ...pane, paneId: prior.paneId } : pane
  })
}

export function normalizeParkedTerminalPaneMaterialBindings(
  panes: readonly ParkedTerminalPaneMaterialBinding[]
): ParkedTerminalPaneMaterialBinding[] {
  return panes
    .map(({ leafId, ptyId }) => ({ leafId, ptyId }))
    .sort(
      (left, right) =>
        left.leafId.localeCompare(right.leafId) ||
        (left.ptyId ?? '').localeCompare(right.ptyId ?? '')
    )
}

export function resolveParkedTerminalPaneMaterialBindings(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  state: ParkedPaneFallbackState
): ParkedTerminalPaneMaterialBinding[] {
  return normalizeParkedTerminalPaneMaterialBindings(
    resolveParkedTerminalPaneCandidates(worktreeId, tab, state)
  )
}

export function createParkedTerminalWatcherTopologyKey(
  worktreeId: string,
  tabs: readonly ParkableTerminalTabModel[],
  state: ParkedPaneTopologyState
): string {
  const topologyState: ParkedPaneFallbackState = {
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    // Runtime titles affect only watcher pane slots, never material leaf-to-PTY topology.
    runtimePaneTitlesByTabId: {}
  }
  return JSON.stringify([
    'terminal-parked-watcher-topology-v1',
    worktreeId,
    [...tabs]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((tab) => [
        tab.id,
        tab.ptyId,
        tab.generation ?? null,
        resolveParkedTerminalPaneMaterialBindings(worktreeId, tab, topologyState)
      ])
  ])
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

export function parkedWatcherRestorePolicyFromState(state: {
  settings: { terminalSshViewParking?: boolean } | null
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    { status: { capabilities?: readonly string[] } | null | undefined }
  >
}): TerminalParkRestorePolicy {
  return {
    sshParkingEnabled: state.settings?.terminalSshViewParking !== false,
    pairedRuntimeParkingEnvironmentIds: selectPairedRuntimeParkingEnvironmentIds(
      state.runtimeStatusByEnvironmentId
    )
  }
}

function watchablePanes(
  worktreeId: string,
  tab: ParkableTerminalTabModel
): Map<string, ParkedTerminalPaneCapture> {
  const state = useAppStore.getState()
  const restorePolicy = parkedWatcherRestorePolicyFromState(state)
  return new Map(
    resolveParkedTerminalPaneCandidates(worktreeId, tab, state).flatMap((pane) =>
      pane.ptyId &&
      isTerminalLeafId(pane.leafId) &&
      isParkRestorableTerminalPty(pane.ptyId, worktreeId, restorePolicy)
        ? [[pane.ptyId, pane] as const]
        : []
    )
  )
}

export function startParkedTabWatchers(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  restoreTitleOnRegister: boolean
): void {
  const entry: ParkedTabWatcherEntry = {
    worktreeId,
    tabPtyId: tab.ptyId,
    paneIdByPtyId: new Map(),
    disposersByPtyId: new Map()
  }
  parkedWatchersByTabId.set(tab.id, entry)
  const restorePolicy = parkedWatcherRestorePolicyFromState(useAppStore.getState())
  for (const pane of resolveParkedTerminalPaneCandidates(worktreeId, tab, useAppStore.getState())) {
    startParkedPtyWatcher({
      worktreeId,
      tab,
      pane,
      entry,
      restoreTitleOnRegister,
      restorePolicy
    })
  }
}

export function reconcileParkedTabWatchers(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  entry: ParkedTabWatcherEntry,
  restoreTitleOnRegister: boolean
): void {
  const state = useAppStore.getState()
  const expectedPanes = watchablePanes(worktreeId, tab)
  const expectedPtyIds = new Set(expectedPanes.keys())
  const reconciliation = reconcileParkedWatcherPtyIds({
    currentTabPtyId: tab.ptyId,
    entryTabPtyId: entry.tabPtyId,
    paneIdByPtyId: entry.paneIdByPtyId,
    expectedPtyIds
  })
  if (reconciliation.restartAll) {
    const retainedTitles = reconciliation.retainedPtyIds.flatMap((ptyId) => {
      const paneId = entry.paneIdByPtyId.get(ptyId)
      const title =
        paneId === undefined ? undefined : state.runtimePaneTitlesByTabId[tab.id]?.[paneId]
      return paneId !== undefined && title !== undefined ? [{ paneId, title }] : []
    })
    for (const paneId of reconciliation.retiredPaneIds) {
      state.clearRuntimePaneTitle(tab.id, paneId)
    }
    disposeParkedTabWatchers(tab.id)
    for (const { paneId, title } of retainedTitles) {
      useAppStore.getState().setRuntimePaneTitle(tab.id, paneId, title)
    }
    startParkedTabWatchers(worktreeId, tab, restoreTitleOnRegister)
    return
  }
  for (const [ptyId, paneId] of Array.from(entry.paneIdByPtyId)) {
    if (expectedPtyIds.has(ptyId)) {
      continue
    }
    entry.paneIdByPtyId.delete(ptyId)
    entry.disposersByPtyId.get(ptyId)?.()
    entry.disposersByPtyId.delete(ptyId)
    state.clearRuntimePaneTitle(tab.id, paneId)
  }
  const restorePolicy = parkedWatcherRestorePolicyFromState(useAppStore.getState())
  for (const ptyId of reconciliation.addedPtyIds) {
    const pane = expectedPanes.get(ptyId)
    if (pane) {
      startParkedPtyWatcher({
        worktreeId,
        tab,
        pane,
        entry,
        restoreTitleOnRegister,
        restorePolicy
      })
    }
  }
}
