import { useAppStore } from '../../store'
import { findActivityTerminalPortal } from '../activity/activity-terminal-portal'
import { selectSleepingRecordParkExemptTabIds } from './sleeping-record-park-exemption'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  selectEvictionExemptTerminalTabLayoutKey,
  selectEvictionExemptTerminalTabIds
} from './terminal-eviction-exempt-tabs'
import { getTerminalPaneSplitMountLeaseTabIds } from './terminal-pane-split-request-routing'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'
import type { TerminalViewParkingInput } from './terminal-tab-parking-policy'
const EMPTY: ReadonlySet<string> = new Set()
const exemptionCache = new WeakMap<
  readonly TerminalTab[],
  { worktreeId: string; layouts: unknown; key: string; ids: ReadonlySet<string> }
>()
function forceParkExemptions(
  worktreeId: string,
  tabs: readonly TerminalTab[]
): ReadonlySet<string> {
  const layouts = useAppStore.getState().terminalLayoutsByTabId
  const cached = exemptionCache.get(tabs)
  if (cached?.worktreeId === worktreeId && cached.layouts === layouts) {
    return cached.ids
  }
  const key = selectEvictionExemptTerminalTabLayoutKey(useAppStore.getState(), tabs)
  const ids =
    cached?.worktreeId === worktreeId && cached.key === key
      ? cached.ids
      : selectEvictionExemptTerminalTabIds(worktreeId, tabs)
  exemptionCache.set(tabs, { worktreeId, layouts, key, ids })
  return ids
}
export function projectTerminalParkingVerdict(
  args: TerminalViewParkingInput,
  coldParkedTerminalTabIds: ReadonlySet<string>,
  pinnedTabIds: ReadonlySet<string>
): ReadonlySet<string> {
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    coldParkTerminalPanes,
    isForceParked = false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    activationDeferredMountTabIds
  } = args
  const state = useAppStore.getState()
  const sleepingRecordOwnedTabIds = selectSleepingRecordParkExemptTabIds(state, worktreeId)
  const evictionExemptTerminalTabIds = isForceParked
    ? forceParkExemptions(worktreeId, terminalTabs)
    : EMPTY
  const terminalPaneSplitMountLeaseTabIds = getTerminalPaneSplitMountLeaseTabIds()
  const parked = new Set<string>()
  for (const terminalTab of terminalTabs) {
    const assignment = assignments.get(terminalTab.id)
    const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
    const hasActivityTerminalPortal =
      findActivityTerminalPortal(activityTerminalPortals, {
        worktreeId,
        tabId: terminalTab.id
      }) !== null
    if (
      (coldParkTerminalPanes ||
        (!isVisible &&
          coldParkedTerminalTabIds.has(terminalTab.id) &&
          // Sleeping panes must mount to consume their resume record.
          !sleepingRecordOwnedTabIds.has(terminalTab.id))) &&
      !hasActivityTerminalPortal &&
      // Force parking cannot orphan PTYs that have no restore path.
      !evictionExemptTerminalTabIds.has(terminalTab.id) &&
      // Why: CLI splits against a parked tab replay as soon as its exact pane remounts.
      !terminalPaneSplitMountLeaseTabIds.has(terminalTab.id) &&
      // Measurement must reveal in the same render.
      !shouldMeasureHiddenWorktree
    ) {
      parked.add(terminalTab.id)
    }
    // Deferred tabs have no pane consumer; targeted restrictions remain separate.
    if (
      activationDeferredMountTabIds?.has(terminalTab.id) &&
      !hasActivityTerminalPortal &&
      canWatcherCoverParkedTerminalTab(worktreeId, terminalTab)
    ) {
      parked.add(terminalTab.id)
    }
  }
  return new Set([...parked].filter((id) => !pinnedTabIds.has(id)))
}
