/** Keep panes mounted when watchers cannot cover them or flip damping pins them; return pin expiry because settled damping removes the other wakeups. */
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  getParkVerdictUnparkPinUntilMs,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'
import { canWatcherCoverParkedTerminalTab } from './terminal-parked-tab-watchers'

export type WithheldTerminalTabParking = {
  parkedTabIds: Set<string>
  parkVerdictPinUntilMsByTabId: Map<string, number>
}

export function withholdUnparkableTerminalTabs(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  coldParkedTabIds: ReadonlySet<string>
  parkVerdictRecords: Map<string, ParkVerdictFlipRecord>
  nowMs: number
}): WithheldTerminalTabParking {
  const parkedTabIds = new Set(args.coldParkedTabIds)
  const parkVerdictPinUntilMsByTabId = new Map<string, number>()

  for (const terminalTab of args.terminalTabs) {
    if (!parkedTabIds.has(terminalTab.id)) {
      continue
    }
    const parkVerdictPinUntilMs = getParkVerdictUnparkPinUntilMs({
      records: args.parkVerdictRecords,
      tabId: terminalTab.id,
      nowMs: args.nowMs
    })
    if (parkVerdictPinUntilMs !== null) {
      parkVerdictPinUntilMsByTabId.set(terminalTab.id, parkVerdictPinUntilMs)
    }
    // Uncovered parked tabs lose bells/titles/completions.
    if (
      parkVerdictPinUntilMs !== null ||
      !canWatcherCoverParkedTerminalTab(args.worktreeId, terminalTab)
    ) {
      parkedTabIds.delete(terminalTab.id)
    }
  }

  return { parkedTabIds, parkVerdictPinUntilMsByTabId }
}
