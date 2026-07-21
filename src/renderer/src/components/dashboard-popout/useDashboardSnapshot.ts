import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  EMPTY_DASHBOARD_SNAPSHOT,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'

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

/**
 * Pop-out side of the dashboard bridge: subscribe to snapshots relayed from the
 * main window and request an initial one on mount. When a card changes column
 * (or one appears/disappears), the update is wrapped in a View Transition so
 * the browser morphs each card from its old position to its new one.
 */
export function useDashboardSnapshot(): DashboardSnapshot {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_DASHBOARD_SNAPSHOT)
  const columnSignatureRef = useRef('')

  useEffect(() => {
    const apply = (next: DashboardSnapshot): void => {
      const nextSignature = columnSignature(next)
      const layoutChanged = nextSignature !== columnSignatureRef.current
      columnSignatureRef.current = nextSignature

      const startViewTransition = document.startViewTransition?.bind(document)
      if (!layoutChanged || prefersReducedMotion() || !startViewTransition) {
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
    void window.api.dashboard.requestSnapshot()
    return unsubscribe
  }, [])

  return snapshot
}
