import { useEffect, useRef, useState } from 'react'
import type { TerminalTab } from '../../../../shared/types'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import { getTerminalTabColdParkRecheckDelayMs } from './terminal-cold-park-recheck-deadlines'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  selectColdParkedTerminalTabs,
  type TerminalTabColdParkCandidate
} from './terminal-hidden-view-parking'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'

export type TerminalOverlayTabAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

function haveSameTerminalTabIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
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

export function useTerminalTabColdParkCandidates(args: {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: readonly ActivityTerminalPortalTarget[]
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  terminalParkingEnabled: boolean
  terminalSshParkingEnabled: boolean
  pairedRuntimeParkingEnvironmentIds: ReadonlySet<string>
}): ReadonlySet<string> {
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals,
    pendingStartupByTabId,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    pairedRuntimeParkingEnvironmentIds
  } = args
  const hiddenSinceByTabIdRef = useRef(new Map<string, number>())
  const wasMeasuringHiddenWorktreeRef = useRef(false)
  const measureParkCooldownUntilRef = useRef<number | null>(null)
  const recheckTimersByTabIdRef = useRef(new Map<string, number>())
  const [recheckRevision, setRecheckRevision] = useState(0)
  const [candidateTabIds, setCandidateTabIds] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const timers = recheckTimersByTabIdRef.current
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  useEffect(() => {
    const timers = recheckTimersByTabIdRef.current
    for (const timer of timers.values()) {
      window.clearTimeout(timer)
    }
    timers.clear()

    const nowMs = Date.now()
    const overrides = getTerminalParkingPolicyOverrides()
    const currentTabIds = new Set(terminalTabs.map((tab) => tab.id))
    const portalTabIds = new Set(
      activityTerminalPortals
        .filter((portal) => portal.worktreeId === worktreeId)
        .map((portal) => portal.tabId)
    )
    for (const tabId of Array.from(hiddenSinceByTabIdRef.current.keys())) {
      if (!currentTabIds.has(tabId)) {
        hiddenSinceByTabIdRef.current.delete(tabId)
      }
    }

    if (shouldMeasureHiddenWorktree) {
      wasMeasuringHiddenWorktreeRef.current = true
    } else {
      if (wasMeasuringHiddenWorktreeRef.current) {
        measureParkCooldownUntilRef.current =
          nowMs + (overrides.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)
      }
      wasMeasuringHiddenWorktreeRef.current = false
    }
    if (isWorktreeActive) {
      measureParkCooldownUntilRef.current = null
    }

    const candidates: TerminalTabColdParkCandidate[] = terminalTabs.map((terminalTab) => {
      const assignment = assignments.get(terminalTab.id)
      const isVisible = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
      const hasActivityTerminalPortal = portalTabIds.has(terminalTab.id)
      if (isVisible || hasActivityTerminalPortal) {
        hiddenSinceByTabIdRef.current.delete(terminalTab.id)
      } else if (
        !shouldMeasureHiddenWorktree &&
        !hiddenSinceByTabIdRef.current.has(terminalTab.id)
      ) {
        hiddenSinceByTabIdRef.current.set(terminalTab.id, nowMs)
      }
      return {
        id: terminalTab.id,
        ptyId: terminalTab.ptyId,
        pendingActivationSpawn: terminalTab.pendingActivationSpawn,
        isVisible,
        hasActivityTerminalPortal,
        hiddenSinceMs: hiddenSinceByTabIdRef.current.get(terminalTab.id) ?? null
      }
    })

    const nextCandidateTabIds = selectColdParkedTerminalTabs({
      worktreeId,
      terminalTabs: candidates,
      pendingStartupByTabId,
      parkingEnabled: terminalParkingEnabled,
      nowMs,
      parkCooldownUntilMs: measureParkCooldownUntilRef.current,
      restorePolicy: {
        sshParkingEnabled: terminalSshParkingEnabled,
        pairedRuntimeParkingEnvironmentIds
      },
      ...overrides
    })
    setCandidateTabIds((current) =>
      haveSameTerminalTabIds(current, nextCandidateTabIds) ? current : nextCandidateTabIds
    )

    for (const candidate of candidates) {
      if (
        candidate.isVisible ||
        candidate.hasActivityTerminalPortal ||
        nextCandidateTabIds.has(candidate.id)
      ) {
        continue
      }
      const delayMs = getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: terminalParkingEnabled,
        hiddenSinceMs: candidate.hiddenSinceMs,
        parkCooldownUntilMs: measureParkCooldownUntilRef.current,
        nowMs,
        ...overrides
      })
      if (delayMs !== null && delayMs > 0) {
        const tabId = candidate.id
        const timer = window.setTimeout(() => {
          timers.delete(tabId)
          setRecheckRevision((revision) => revision + 1)
        }, delayMs)
        timers.set(tabId, timer)
      }
    }
  }, [
    activityTerminalPortals,
    assignments,
    isWorktreeActive,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    recheckRevision,
    shouldMeasureHiddenWorktree,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    terminalTabs,
    worktreeId
  ])

  return candidateTabIds
}
