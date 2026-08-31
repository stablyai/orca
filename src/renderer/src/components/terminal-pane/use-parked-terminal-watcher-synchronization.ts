import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore, type AppState } from '../../store'
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

/** Length-prefixed concatenation: injective for arbitrary fragments, and unlike
 *  JSON.stringify it never rescans a fragment to escape characters it contains. */
function joinKeyFragments(fragments: readonly string[]): string {
  let key = ''
  for (const fragment of fragments) {
    key += `${fragment.length}:${fragment}`
  }
  return key
}

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
  return joinKeyFragments([
    args.worktreeId,
    args.inputsKey,
    args.assignmentsKey,
    joinKeyFragments(Array.from(args.parkedTabIds)),
    joinKeyFragments(Array.from(args.activationDeferredMountTabIds ?? []).sort()),
    args.reconciliationKey
  ])
}

function getCapturedPaneKey(terminalTabs: readonly TerminalTab[]): string {
  return JSON.stringify(
    terminalTabs.map((tab) => {
      const capture = capturedPanesByTabId.get(tab.id)
      return [
        tab.id,
        capture?.worktreeId ?? null,
        capture?.panes.map((pane) => [pane.ptyId, pane.paneId, pane.leafId, pane.drivesTabTitle]) ??
          []
      ]
    })
  )
}

/** The store-derived half of the reconciliation key. Split out because it is a
 *  pure function of shallow-stable selector output, so it memoizes; the captured
 *  pane half reads a registry mutated outside React and cannot. */
function getWatcherReconciliationStoreInputsKey(
  terminalTabs: readonly TerminalTab[],
  inputs: WatcherReconciliationStoreInputs
): string {
  if (inputs.length === 0) {
    return ''
  }
  return JSON.stringify(
    terminalTabs.map((tab, index) => {
      const offset = index * 3
      const layout = inputs[offset + 1] as TerminalLayoutSnapshot | null
      return [
        tab.id,
        inputs[offset] as readonly string[],
        layout?.root ?? null,
        layout?.activeLeafId ?? null,
        layout?.ptyIdsByLeafId ?? null,
        inputs[offset + 2] as string
      ]
    })
  )
}

function getWatcherReconciliationKey(
  terminalTabs: readonly TerminalTab[],
  storeInputsKey: string
): string {
  if (storeInputsKey === '') {
    return ''
  }
  return joinKeyFragments([storeInputsKey, getCapturedPaneKey(terminalTabs)])
}

function selectWatcherReconciliationStoreInputs(
  state: AppState,
  terminalTabs: readonly TerminalTab[]
): WatcherReconciliationStoreInputs {
  return terminalTabs.flatMap((tab) => [
    state.ptyIdsByTabId[tab.id] ?? EMPTY_PTY_IDS,
    state.terminalLayoutsByTabId[tab.id] ?? null,
    Object.keys(state.runtimePaneTitlesByTabId[tab.id] ?? {}).join(',')
  ])
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
    useShallow((state: AppState) =>
      // Why: an empty committed park set has no live watcher state for store writes to reconcile.
      parkedTabIds.size === 0
        ? EMPTY_WATCHER_RECONCILIATION_INPUTS
        : selectWatcherReconciliationStoreInputs(state, terminalTabs)
    )
  )
  // Why memoized: serializing the split tree per tab is the dominant cost here,
  // and the shallow selector output only changes when the serialization would.
  const reconciliationStoreInputsKey = useMemo(
    () => getWatcherReconciliationStoreInputsKey(terminalTabs, reconciliationStoreInputs),
    [reconciliationStoreInputs, terminalTabs]
  )
  const reconciliationKey = getWatcherReconciliationKey(terminalTabs, reconciliationStoreInputsKey)
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
      reconciliationKey: getWatcherReconciliationKey(terminalTabs, reconciliationStoreInputsKey)
    })
  }, [
    activationDeferredMountTabIds,
    assignmentsKey,
    inputsKey,
    parkedTabIds,
    reconciliationStoreInputsKey,
    synchronizationKey,
    terminalTabs,
    worktreeId
  ])
}
