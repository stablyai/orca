import type { TerminalTab } from '../../../../shared/types'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from '../activity/activity-terminal-portal'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'

type TerminalParkingAssignment = { isActiveInGroup: boolean }

export function selectRenderedParkedTerminalTabIds(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalParkingAssignment>
  isWorktreeActive: boolean
  coldParkTerminalPanes: boolean
  coldParkedTerminalTabIds: ReadonlySet<string>
  sleepingRecordOwnedTabIds: ReadonlySet<string>
  evictionExemptTerminalTabIds: ReadonlySet<string>
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}): ReadonlySet<string> {
  const parked = new Set<string>()
  for (const terminalTab of args.terminalTabs) {
    const assignment = args.assignments.get(terminalTab.id)
    const isVisible = Boolean(args.isWorktreeActive && assignment && assignment.isActiveInGroup)
    const hasActivityTerminalPortal =
      findActivityTerminalPortal(args.activityTerminalPortals, {
        worktreeId: args.worktreeId,
        tabId: terminalTab.id
      }) !== null
    const ordinaryParked =
      !isVisible &&
      args.coldParkedTerminalTabIds.has(terminalTab.id) &&
      !args.sleepingRecordOwnedTabIds.has(terminalTab.id)
    if (
      (args.coldParkTerminalPanes || ordinaryParked) &&
      !hasActivityTerminalPortal &&
      !args.evictionExemptTerminalTabIds.has(terminalTab.id) &&
      !args.shouldMeasureHiddenWorktree
    ) {
      parked.add(terminalTab.id)
    }
    if (
      args.activationDeferredMountTabIds?.has(terminalTab.id) &&
      !hasActivityTerminalPortal &&
      canWatcherCoverParkedTerminalTab(args.worktreeId, terminalTab)
    ) {
      parked.add(terminalTab.id)
    }
  }
  return parked
}
