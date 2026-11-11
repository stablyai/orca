import {
  retainedTerminalSnapshotAuthority,
  retiresRetainedTerminalStart
} from './retained-terminal-start-authority'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { retainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import { toWebTerminalSurfaceTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-pane-layout-tree'
import { retainedStartSupersedes } from '@/store/terminals/retained-terminal-start-lifecycle'
import { sessionTabsRuntimeHistoryByEnvironment, type WebSessionTabsSyncState } from './state'

/** Only current host publications supply transient starts; saved mirrored tabs carry none. */
export function retainedTerminalStartPatch(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  removedTabIds: Iterable<string> = [],
  acceptedSnapshot: RuntimeMobileSessionTabsResult = snapshot
): Partial<WebSessionTabsSyncState> {
  const starts = state.terminalPaneStartsByPaneKey
  let next = starts
  const write = (): typeof starts => (next === starts ? (next = { ...starts }) : next)
  const currentRuntimeId = sessionTabsRuntimeHistoryByEnvironment.get(environmentId)?.current
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'terminal') {
      continue
    }
    const evidence = retainedTerminalSnapshotAuthority(acceptedSnapshot, environmentId, {
      worktreeId: snapshot.worktree,
      tabId: tab.parentTabId,
      leafId: tab.leafId
    })
    const tabId = toWebTerminalSurfaceTabId(tab.parentTabId)
    const key = `${tabId}:${tab.leafId}`
    const previous = starts[key]?.retainedTerminalStart
    if ((evidence?.row ?? tab).status === 'ready') {
      if (previous) {
        delete write()[key]
      }
      continue
    }
    if (!evidence) {
      continue
    }
    const { row, authority } = evidence
    if (!Object.hasOwn(row, 'retainedTerminalStart')) {
      if (retiresRetainedTerminalStart(starts[key], authority)) {
        delete write()[key]
      }
      continue
    }
    const parsed = retainedTerminalStart.safeParse(row.retainedTerminalStart)
    if (!parsed.success) {
      continue
    }
    const start = parsed.data
    if (
      start.runtimeId !== currentRuntimeId ||
      start.worktreeId !== snapshot.worktree ||
      start.tabId !== tab.parentTabId ||
      start.leafId !== tab.leafId ||
      !retainedStartSupersedes(previous, start)
    ) {
      continue
    }
    if (
      previous?.runtimeId === start.runtimeId &&
      previous.startSequence === start.startSequence &&
      previous.bindingGeneration === start.bindingGeneration &&
      previous.reason === start.reason &&
      previous.status === start.status
    ) {
      if (!starts[key]?.retainedHostReceipt) {
        write()[key] = { ...starts[key]!, retainedHostReceipt: authority }
      }
      continue
    }
    write()[key] = {
      status: start.status,
      reason: start.reason,
      retainedTerminalStart: start,
      retainedHostReceipt: authority
    }
  }
  for (const tabId of removedTabIds) {
    const layout = state.terminalLayoutsByTabId[tabId]
    for (const leafId of collectLeafIds(layout?.root)) {
      const key = `${tabId}:${leafId}`
      if (starts[key]?.retainedTerminalStart) {
        delete write()[key]
      }
    }
  }
  return next === starts ? {} : { terminalPaneStartsByPaneKey: next }
}
