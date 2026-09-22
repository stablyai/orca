import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS,
  createActivityPortalReadinessLatch,
  type ActivityPortalReadinessLatch
} from './activity-portal-readiness-oscillation'
import type {
  ActivityTerminalPortalDomStatus,
  ActivityTerminalPortalReadiness,
  ActivityTerminalPortalSlotId
} from './activity-thread-types'

const ACTIVITY_TERMINAL_LOADING_LABEL_DELAY_MS = 180

function findActivityTerminalPane(
  root: HTMLElement,
  leafId: string
): { foundAnyPane: boolean; pane: HTMLElement | null } {
  let foundAnyPane = false
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-leaf-id]')) {
    foundAnyPane = true
    if (candidate.dataset.leafId === leafId) {
      return { foundAnyPane, pane: candidate }
    }
  }
  return { foundAnyPane, pane: null }
}

function hasInlineDisplayNoneBetween(element: HTMLElement, root: HTMLElement): boolean {
  let current: HTMLElement | null = element
  while (current) {
    if (current.style.display === 'none') {
      return true
    }
    if (current === root) {
      return false
    }
    current = current.parentElement
  }
  return false
}

function hasUnhiddenSiblingPane(root: HTMLElement, selectedPane: HTMLElement): boolean {
  for (const candidate of root.querySelectorAll<HTMLElement>('[data-leaf-id]')) {
    if (candidate !== selectedPane && !hasInlineDisplayNoneBetween(candidate, root)) {
      return true
    }
  }
  return false
}

function getSelectedActivityTerminalPortalStatus(
  target: HTMLElement,
  paneKey: string
): ActivityTerminalPortalDomStatus {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return { ready: false, unavailable: true }
  }
  let selectedRoot: HTMLElement | null = null
  for (const candidate of target.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (candidate.dataset.terminalTabId === parsed.tabId) {
      selectedRoot = candidate
      break
    }
  }
  if (!selectedRoot) {
    return { ready: false, unavailable: false }
  }

  const { foundAnyPane, pane: selectedPane } = findActivityTerminalPane(selectedRoot, parsed.leafId)
  if (!selectedPane) {
    return { ready: false, unavailable: foundAnyPane }
  }

  const unavailable = hasInlineDisplayNoneBetween(selectedPane, selectedRoot)
  const hasUnisolatedSibling = hasUnhiddenSiblingPane(selectedRoot, selectedPane)
  const isVisibleRoot =
    !unavailable && (selectedPane.offsetParent !== null || selectedPane.getClientRects().length > 0)
  const hasPtyBinding =
    selectedPane.hasAttribute('data-pty-id') ||
    selectedPane.querySelector<HTMLElement>('[data-pty-id]') !== null
  const hasXtermScreen = selectedPane.querySelector<HTMLElement>('.xterm-screen') !== null
  return {
    ready: isVisibleRoot && !hasUnisolatedSibling && hasPtyBinding && hasXtermScreen,
    unavailable
  }
}

export function useActivityTerminalPortalStatus(
  target: HTMLElement | null,
  paneKey: string | null,
  forceUnavailable = false
): ActivityTerminalPortalReadiness['status'] {
  const [readiness, setReadiness] = useState<ActivityTerminalPortalReadiness>({
    target: null,
    paneKey: null,
    status: 'loading'
  })
  // Why: portal churn replaces every subscription identity, so the burst budget must outlive it.
  const readinessLatchRef = useRef<ActivityPortalReadinessLatch | null>(null)

  useLayoutEffect(() => {
    let disposed = false
    let readinessFrame: number | null = null
    let readinessReleaseTimer: number | null = null
    let pendingStatus: ActivityTerminalPortalReadiness['status'] | null = null

    // Why: coalesce observer bursts and cancel frames from stale portal subscriptions.
    const scheduleReadiness = (status: ActivityTerminalPortalReadiness['status']): void => {
      if (disposed) {
        return
      }
      pendingStatus = status
      if (readinessFrame !== null) {
        return
      }
      readinessFrame = requestAnimationFrame(() => {
        readinessFrame = null
        const nextStatus = pendingStatus
        pendingStatus = null
        if (disposed || nextStatus === null) {
          return
        }
        setReadiness((prev) =>
          prev.target === target && prev.paneKey === paneKey && prev.status === nextStatus
            ? prev
            : { target, paneKey, status: nextStatus }
        )
      })
    }

    const disposeFrame = (): void => {
      disposed = true
      if (readinessFrame !== null) {
        cancelAnimationFrame(readinessFrame)
        readinessFrame = null
      }
      if (readinessReleaseTimer !== null) {
        window.clearTimeout(readinessReleaseTimer)
        readinessReleaseTimer = null
      }
    }

    if (!target || !paneKey) {
      scheduleReadiness('loading')
      return disposeFrame
    }
    if (forceUnavailable) {
      scheduleReadiness('unavailable')
      return disposeFrame
    }

    const readinessLatch = (readinessLatchRef.current ??= createActivityPortalReadinessLatch())

    const updateReadiness = (status: ActivityTerminalPortalReadiness['status']): void => {
      const nextStatus = readinessLatch.next(status)
      scheduleReadiness(nextStatus)
      if (readinessReleaseTimer !== null) {
        window.clearTimeout(readinessReleaseTimer)
        readinessReleaseTimer = null
      }
      if (nextStatus !== status) {
        // Why: a quiet loading pane has no mutation to release the burst latch on its own.
        readinessReleaseTimer = window.setTimeout(
          checkReadiness,
          ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS
        )
      }
    }

    const checkReadiness = (): void => {
      const status = getSelectedActivityTerminalPortalStatus(target, paneKey)
      if (status.unavailable) {
        updateReadiness('unavailable')
        return
      }
      if (status.ready) {
        updateReadiness('ready')
        return
      }
      updateReadiness('loading')
    }

    checkReadiness()

    const observer = new MutationObserver(checkReadiness)
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-terminal-tab-id', 'data-leaf-id', 'data-pty-id', 'style']
    })

    return () => {
      disposeFrame()
      observer.disconnect()
    }
  }, [target, paneKey, forceUnavailable])

  return readiness.target === target && readiness.paneKey === paneKey ? readiness.status : 'loading'
}

export function otherActivityTerminalSlot(
  slotId: ActivityTerminalPortalSlotId
): ActivityTerminalPortalSlotId {
  return slotId === 'primary' ? 'secondary' : 'primary'
}

export function useActivityTerminalLoadingLabel(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const [visibleLoading, setVisibleLoading] = useState(loading)

  if (visibleLoading !== loading) {
    setVisibleLoading(loading)
    if (visible) {
      setVisible(false)
    }
  }

  useEffect(() => {
    if (!loading) {
      return
    }
    const timer = setTimeout(() => setVisible(true), ACTIVITY_TERMINAL_LOADING_LABEL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])

  return loading && visible
}
