import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import {
  disposeParkedTerminalWatchersForWorktree,
  syncParkedTerminalTabWatchers
} from './terminal-parked-tab-watchers'
import { capturedPanesByTabId } from './terminal-parked-watcher-registry'

type TerminalParkingAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_PTY_IDS: readonly string[] = []

type WatcherReconciliationStoreInputs = readonly (
  | readonly string[]
  | TerminalLayoutSnapshot
  | string
  | null
)[]

const EMPTY_WATCHER_RECONCILIATION_INPUTS: WatcherReconciliationStoreInputs = Object.freeze([])

export function getTerminalParkingInputsKey(terminalTabs: readonly TerminalTab[]): string {
  return JSON.stringify(terminalTabs.map((tab) => [tab.id, tab.ptyId, tab.pendingActivationSpawn]))
}

export function getTerminalParkingAssignmentsKey(
  assignments: ReadonlyMap<string, TerminalParkingAssignment>
): string {
  return JSON.stringify(
    Array.from(assignments, ([tabId, assignment]) => [
      tabId,
      assignment.groupId,
      assignment.isActiveInGroup
    ])
  )
}

function getWatcherSynchronizationKey(args: {
  worktreeId: string
  inputsKey: string
  assignmentsKey: string
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
  reconciliationKey: string
}): string {
  return JSON.stringify([
    args.worktreeId,
    args.inputsKey,
    args.assignmentsKey,
    Array.from(args.parkedTabIds),
    Array.from(args.activationDeferredMountTabIds ?? []).sort(),
    args.reconciliationKey
  ])
}

function getCapturedPaneKey(terminalTabs: readonly TerminalTab[]): unknown[] {
  return terminalTabs.map((tab) => {
    const capture = capturedPanesByTabId.get(tab.id)
    return [
      tab.id,
      capture?.worktreeId ?? null,
      capture?.panes.map((pane) => [pane.ptyId, pane.paneId, pane.leafId, pane.drivesTabTitle]) ??
        []
    ]
  })
}

function getWatcherReconciliationKey(
  terminalTabs: readonly TerminalTab[],
  inputs: WatcherReconciliationStoreInputs
): string {
  if (inputs.length === 0) {
    return ''
  }
  const tabs = terminalTabs.map((tab, index) => {
    const offset = index * 3
    const ptyIds = inputs[offset] as readonly string[]
    const layout = inputs[offset + 1] as TerminalLayoutSnapshot | null
    const titleSlotKey = inputs[offset + 2] as string
    return [
      tab.id,
      ptyIds,
      layout?.root ?? null,
      layout?.activeLeafId ?? null,
      layout?.ptyIdsByLeafId ?? null,
      titleSlotKey
    ]
  })
  return JSON.stringify([tabs, getCapturedPaneKey(terminalTabs)])
}

export function useParkedTerminalWatcherSynchronization(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  inputsKey: string
  assignmentsKey: string
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): void {
  const {
    worktreeId,
    terminalTabs,
    inputsKey,
    assignmentsKey,
    parkedTabIds,
    activationDeferredMountTabIds
  } = args
  const reconciliationStoreInputs = useAppStore(
    useShallow((state) =>
      // Why: an empty committed park set has no live watcher state for store writes to reconcile.
      parkedTabIds.size === 0
        ? EMPTY_WATCHER_RECONCILIATION_INPUTS
        : terminalTabs.flatMap((tab) => [
            state.ptyIdsByTabId[tab.id] ?? EMPTY_PTY_IDS,
            state.terminalLayoutsByTabId[tab.id] ?? null,
            Object.keys(state.runtimePaneTitlesByTabId[tab.id] ?? {}).join(',')
          ])
    )
  ) as WatcherReconciliationStoreInputs
  const reconciliationKey = getWatcherReconciliationKey(terminalTabs, reconciliationStoreInputs)
  const synchronizationKey = getWatcherSynchronizationKey({ ...args, reconciliationKey })
  const synchronizationKeyRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      synchronizationKeyRef.current = null
      disposeParkedTerminalWatchersForWorktree(worktreeId)
    },
    [worktreeId]
  )

  useEffect(() => {
    if (synchronizationKeyRef.current === synchronizationKey) {
      return
    }
    syncParkedTerminalTabWatchers({
      worktreeId,
      tabs: terminalTabs,
      parkedTabIds,
      // Why: activation-deferred tabs have no prior pane-owned title slot.
      restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
    })
    // Why: capture cleanup mutates the registry during commit; store its post-commit key.
    synchronizationKeyRef.current = getWatcherSynchronizationKey({
      worktreeId,
      inputsKey,
      assignmentsKey,
      parkedTabIds,
      activationDeferredMountTabIds,
      reconciliationKey: getWatcherReconciliationKey(terminalTabs, reconciliationStoreInputs)
    })
  }, [
    activationDeferredMountTabIds,
    assignmentsKey,
    inputsKey,
    parkedTabIds,
    reconciliationStoreInputs,
    synchronizationKey,
    terminalTabs,
    worktreeId
  ])
}
