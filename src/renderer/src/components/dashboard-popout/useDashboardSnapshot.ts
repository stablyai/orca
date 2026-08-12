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

/** Which column each card sits in — the only thing a view transition should
 *  animate on. Content-only updates (such as new messages) must not. */
function columnSignature(snapshot: DashboardSnapshot): string {
  return snapshot.cards
    .map((card) => `${card.paneKey}:${card.bucket}`)
    .sort()
    .join(',')
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Why: View Transition snapshots render in the browser top layer, which paints
 *  above any z-index — so a card morphing columns would flicker OVER the open
 *  terminal dialog (a z-50 Radix portal). Skip the transition while it's open;
 *  the card just settles under the dialog, which the user isn't watching. */
function terminalDialogIsOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null
}

/**
 * Pop-out side of the dashboard bridge: subscribe to snapshots relayed from the
 * main window and request an initial one on mount. When a card changes column
 * (or one appears/disappears), the update is wrapped in a View Transition so
 * the browser morphs each card from its old position to its new one.
 */
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
      // The bridge omits repoIconsByRepoId on throttled republishes when it has
      // not changed, rather than re-sending data URLs 4x/sec. Retain the last
      // map we were given; the bridge always re-sends it when this window opens
      // or asks, so the retained value can never be the only copy.
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
        prefersReducedMotion() ||
        terminalDialogIsOpen() ||
        !startViewTransition
      ) {
        setSnapshot(next)
        return
      }
      // flushSync so the DOM reflects `next` synchronously inside the transition
      // callback — the browser captures the "after" state from it.
      startViewTransition(() => {
        flushSync(() => setSnapshot(next))
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
