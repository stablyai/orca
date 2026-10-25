/** Damp the final rendered verdict, including worktree/activation inputs that bypass cold-park candidates (#15136). The passive-effect pin lags one commit so rendering unparked settles the flip loop. */
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

export function useTerminalParkVerdictPin(args: {
  records: React.RefObject<Map<string, ParkVerdictFlipRecord>>
  terminalTabs: readonly TerminalTab[]
  candidateParkedTabIds: ReadonlySet<string>
  allowSustainedPin: boolean
}): ReadonlySet<string> {
  const { records, terminalTabs, candidateParkedTabIds, allowSustainedPin } = args
  const [pinnedTabIds, setPinnedTabIds] = useState<ReadonlySet<string>>(EMPTY_TAB_IDS)
  const pinnedTabIdsRef = useRef(pinnedTabIds)
  // Pin expiry must rerun observation so it expires the record in place.
  const [pinExpiryRevision, setPinExpiryRevision] = useState(0)
  // Retain an unchanged absolute timer deadline across frequent tab-model writes.
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
      nowMs,
      allowSustainedPin
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
  }, [allowSustainedPin, parkedTabIds, pinExpiryRevision, records, terminalTabs])

  // Observation reruns retain the timer, so separate unmount cleanup owns disposal.
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
