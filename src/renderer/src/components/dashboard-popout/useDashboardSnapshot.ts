import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import {
  EMPTY_DASHBOARD_SNAPSHOT,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

const TOPOLOGY_REFRESH_DEBOUNCE_MS = 250
const TOPOLOGY_REFRESH_MAX_WAIT_MS = 1_000

/** Animate column membership changes only, not content updates. */
function columnSignature(snapshot: DashboardSnapshot): string {
  return snapshot.cards
    .map((card) => `${card.paneKey}:${card.bucket}`)
    .sort()
    .join(',')
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Hidden-document transitions reject ready with InvalidStateError, including pop-out occlusion by the main window. */
function documentIsHidden(): boolean {
  return document.visibilityState === 'hidden'
}

/** Transition snapshots paint above all z-index layers; skip morphing while a terminal dialog is open. */
function terminalDialogIsOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null
}

/** Receive relayed snapshots and request one on mount; animate column membership changes when the document permits it. */
export function useDashboardSnapshot(): DashboardSnapshot {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_DASHBOARD_SNAPSHOT)
  const columnSignatureRef = useRef('')
  const retainedRepoIconsRef = useRef<DashboardSnapshot['repoIconsByRepoId']>(undefined)
  const snapshotRef = useRef(snapshot)

  useEffect(() => {
    let topologyRefreshTimer: ReturnType<typeof setTimeout> | null = null
    let topologyRefreshStartedAt: number | null = null
    let staleRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const transientClearWatermarks = new Map<string, number>()

    const requestTopologyRefresh = (): void => {
      if (topologyRefreshTimer) {
        clearTimeout(topologyRefreshTimer)
      }
      const now = Date.now()
      topologyRefreshStartedAt ??= now
      const remainingMaxWait = Math.max(
        0,
        TOPOLOGY_REFRESH_MAX_WAIT_MS - (now - topologyRefreshStartedAt)
      )
      topologyRefreshTimer = setTimeout(
        () => {
          topologyRefreshTimer = null
          topologyRefreshStartedAt = null
          void window.api.dashboard.requestSnapshot()
        },
        Math.min(TOPOLOGY_REFRESH_DEBOUNCE_MS, remainingMaxWait)
      )
    }

    const scheduleStaleRefresh = (next: DashboardSnapshot): void => {
      if (staleRefreshTimer) {
        clearTimeout(staleRefreshTimer)
        staleRefreshTimer = null
      }
      let nextDeadline = Number.POSITIVE_INFINITY
      for (const card of next.cards) {
        if (
          card.statusUpdatedAt !== undefined &&
          (card.dotState === 'working' ||
            card.dotState === 'blocked' ||
            card.dotState === 'waiting')
        ) {
          nextDeadline = Math.min(nextDeadline, card.statusUpdatedAt + AGENT_STATUS_STALE_AFTER_MS)
        }
      }
      if (Number.isFinite(nextDeadline)) {
        staleRefreshTimer = setTimeout(
          requestTopologyRefresh,
          Math.max(0, nextDeadline - Date.now() + 1)
        )
      }
    }

    const apply = (incoming: DashboardSnapshot): void => {
      // Retain omitted icon maps to avoid cloning data URLs on every publish; opening/requesting always sends a full map.
      const next =
        incoming.repoIconsByRepoId === undefined && retainedRepoIconsRef.current
          ? { ...incoming, repoIconsByRepoId: retainedRepoIconsRef.current }
          : incoming
      if (next.repoIconsByRepoId !== undefined) {
        retainedRepoIconsRef.current = next.repoIconsByRepoId
      }
      snapshotRef.current = next
      scheduleStaleRefresh(next)
      const nextSignature = columnSignature(next)
      const layoutChanged = nextSignature !== columnSignatureRef.current
      columnSignatureRef.current = nextSignature

      const startViewTransition = document.startViewTransition?.bind(document)
      if (
        !layoutChanged ||
        documentIsHidden() ||
        prefersReducedMotion() ||
        terminalDialogIsOpen() ||
        !startViewTransition
      ) {
        setSnapshot(next)
        return
      }
      // Commit DOM synchronously for the transition’s after-image; consume only occlusion aborts and surface other failures.
      void startViewTransition(() => {
        flushSync(() => setSnapshot(next))
      }).ready.catch((error: unknown) => {
        if (
          documentIsHidden() &&
          error instanceof DOMException &&
          error.name === 'InvalidStateError'
        ) {
          return
        }
        throw error
      })
    }

    const unsubscribe = window.api.dashboard.onSnapshot(apply)
    const unsubscribeStatus = window.api.agentStatus.onSet((event) => {
      if (
        typeof event.connectionId === 'string' &&
        event.receivedAt <= (transientClearWatermarks.get(event.connectionId) ?? -1)
      ) {
        return
      }
      const result = patchDashboardSnapshotFromAgentStatus(snapshotRef.current, event)
      if (!result.matched) {
        if (snapshotRef.current.generatedAt !== 0) {
          requestTopologyRefresh()
        }
        return
      }
      if (result.snapshot !== snapshotRef.current) {
        apply(result.snapshot)
      }
    })
    const unsubscribeClear = window.api.agentStatus.onClear((event) => {
      if ('transient' in event && event.transient) {
        transientClearWatermarks.set(
          event.connectionId,
          Math.max(transientClearWatermarks.get(event.connectionId) ?? -1, event.clearedAt)
        )
      }
      requestTopologyRefresh()
    })
    void window.api.dashboard.requestSnapshot()
    return () => {
      unsubscribe()
      unsubscribeStatus()
      unsubscribeClear()
      if (topologyRefreshTimer) {
        clearTimeout(topologyRefreshTimer)
      }
      if (staleRefreshTimer) {
        clearTimeout(staleRefreshTimer)
      }
    }
  }, [])

  return snapshot
}
