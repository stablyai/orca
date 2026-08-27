/**
 * Last gate between a cold-park candidate and an unmounted pane.
 *
 * Two reasons withhold a tab, both settling on the safe mounted side: the byte
 * watchers cannot cover it, or a verdict-flip burst pinned it. The pin deadline
 * is returned because it is also the only remaining recheck wakeup once damping
 * has stopped the churn that was waking the parking effect.
 */
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
    // Why coverage matters: a parked tab the watchers cannot reach goes silent
    // for bells/titles/completions — the failure that sank the first attempt.
    if (
      parkVerdictPinUntilMs !== null ||
      !canWatcherCoverParkedTerminalTab(args.worktreeId, terminalTab)
    ) {
      parkedTabIds.delete(terminalTab.id)
    }
  }

  return { parkedTabIds, parkVerdictPinUntilMsByTabId }
}
