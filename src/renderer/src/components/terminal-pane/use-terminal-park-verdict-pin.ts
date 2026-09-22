/**
 * Applies verdict-flip damping to the *rendered* park verdict.
 *
 * Why here and not inside the cold-park selector: every park input feeds one
 * rendered set, and several of them (worktree-level park, activation-deferred
 * mounts) bypass the cold-park candidate list entirely. Damping only that list
 * left those drivers free to remount a pane at commit cadence while the burst
 * pin silenced its own breadcrumb for the window — issue #15136, where one tab
 * re-burst 60 008 / 60 020 / 60 012 ms apart, i.e. the instant each pin lapsed.
 *
 * The pin lags the verdict by one commit (it is set from the passive effect
 * that observes the flip), which is what lets the loop settle instead of
 * feeding itself: pinned tabs render unparked, so the next observation records
 * no flip.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  recordParkVerdictFlips,
  selectParkVerdictPinnedTabIds,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'

const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

export function haveSameTerminalTabIds(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const id of left) {
    if (!right.has(id)) {
      return false
    }
  }
  return true
}

/**
 * Returns the park verdict with flip-pinned tabs removed, and records churn on
 * that same (rendered) verdict.
 */
export function useTerminalParkVerdictPin(args: {
  records: React.RefObject<Map<string, ParkVerdictFlipRecord>>
  terminalTabs: readonly TerminalTab[]
  /** Park verdict before damping — every input already merged. */
  candidateParkedTabIds: ReadonlySet<string>
}): ReadonlySet<string> {
  const { records, terminalTabs, candidateParkedTabIds } = args
  const [pinnedTabIds, setPinnedTabIds] = useState<ReadonlySet<string>>(EMPTY_TAB_IDS)
  const pinnedTabIdsRef = useRef(pinnedTabIds)
  // Why a revision and not a raw timer callback: the pin lapse must re-run the
  // observation effect, which is also what expires the record in place.
  const [pinExpiryRevision, setPinExpiryRevision] = useState(0)
  // Why armed-deadline bookkeeping: this effect re-runs on every tab-model
  // write (runtime titles, unread bumps), which on a busy agent pane is many
  // times a second. Re-arming an unchanged absolute deadline each time is pure
  // churn — keep the live timer instead.
  const armedPinExpiryRef = useRef<{ deadlineMs: number; timer: number } | null>(null)

  const parkedTabIds = useMemo(() => {
    if (pinnedTabIds.size === 0) {
      return candidateParkedTabIds
    }
    const parked = new Set<string>()
    for (const tabId of candidateParkedTabIds) {
      if (!pinnedTabIds.has(tabId)) {
        parked.add(tabId)
      }
    }
    return parked
  }, [candidateParkedTabIds, pinnedTabIds])

  useEffect(() => {
    const flipRecords = records.current
    const liveTabIds = new Set(terminalTabs.map((terminalTab) => terminalTab.id))
    const nowMs = Date.now()
    recordParkVerdictFlips({
      records: flipRecords,
      liveTabIds,
      nextParkedTabIds: parkedTabIds,
      nowMs
    })
    const { pinnedTabIds: nextPinnedTabIds, earliestPinExpiryMs } = selectParkVerdictPinnedTabIds({
      records: flipRecords,
      tabIds: liveTabIds,
      nowMs
    })
    if (!haveSameTerminalTabIds(pinnedTabIdsRef.current, nextPinnedTabIds)) {
      pinnedTabIdsRef.current = nextPinnedTabIds
      setPinnedTabIds(nextPinnedTabIds)
    }
    const armed = armedPinExpiryRef.current
    if (earliestPinExpiryMs === null) {
      if (armed) {
        window.clearTimeout(armed.timer)
        armedPinExpiryRef.current = null
      }
      return
    }
    if (armed?.deadlineMs === earliestPinExpiryMs) {
      return
    }
    if (armed) {
      window.clearTimeout(armed.timer)
    }
    armedPinExpiryRef.current = {
      deadlineMs: earliestPinExpiryMs,
      timer: window.setTimeout(
        () => setPinExpiryRevision((revision) => revision + 1),
        Math.max(1, earliestPinExpiryMs - nowMs)
      )
    }
  }, [parkedTabIds, pinExpiryRevision, records, terminalTabs])

  // Why separate from the observation effect: that effect intentionally keeps a
  // live timer across its own re-runs, so its cleanup cannot own disposal.
  useEffect(() => {
    const armedPinExpiry = armedPinExpiryRef
    return () => {
      if (armedPinExpiry.current) {
        window.clearTimeout(armedPinExpiry.current.timer)
        armedPinExpiry.current = null
      }
    }
  }, [])

  return parkedTabIds
}
