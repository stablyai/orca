import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { useAppStore } from '@/store'
import {
  RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS,
  getRightSidebarEdgePeekSettingsLinkLabel,
  getRightSidebarEdgePeekTipSettingsPrefix,
  getRightSidebarEdgePeekTipTitle,
  markRightSidebarEdgePeekTipDismissed,
  openRightSidebarEdgePeekSetting,
  shouldShowRightSidebarEdgePeekTip
} from './right-sidebar-edge-peek-tip'
import { isRightSidebarEdgePeekEnabled } from './right-sidebar-edge-peek-preference'

const TOGGLE_SELECTOR = '[data-right-sidebar-toggle]'

type AnchorRect = { top: number; left: number; width: number; height: number }

function measureToggleAnchor(): AnchorRect | null {
  const el = document.querySelector(TOGGLE_SELECTOR)
  if (!(el instanceof HTMLElement)) {
    return null
  }
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

/**
 * One-shot tip anchored under the right-sidebar titlebar toggle after the first
 * close while peek is enabled. Auto-hides after a short delay. Successful peeks
 * also mark the tip seen.
 */
export function RightSidebarEdgePeekTipHost(): JSX.Element | null {
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const rightSidebarPeek = useAppStore((s) => s.rightSidebarPeek)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const [visible, setVisible] = useState(false)
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  // Why: only fire on a true open→closed transition, not on first mount when
  // the sidebar happens to start closed (no prior close gesture to teach from).
  const prevOpenRef = useRef(rightSidebarOpen)
  const hideTimerRef = useRef<number | null>(null)
  const updateSettingsRef = useRef(updateSettings)
  updateSettingsRef.current = updateSettings

  const clearHideTimer = (): void => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const dismissVisibleTip = (): void => {
    clearHideTimer()
    setVisible(false)
    markRightSidebarEdgePeekTipDismissed({ updateSettings: updateSettingsRef.current })
  }

  const scheduleHide = (): void => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setVisible(false)
      markRightSidebarEdgePeekTipDismissed({ updateSettings: updateSettingsRef.current })
    }, RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS)
  }

  useEffect(() => {
    return () => clearHideTimer()
  }, [])

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = rightSidebarOpen
    if (!wasOpen || rightSidebarOpen) {
      return
    }
    if (!shouldShowRightSidebarEdgePeekTip(settings)) {
      return
    }
    setVisible(true)
    // Why: brief, non-blocking discoverability — not a sticky toast.
    scheduleHide()
  }, [rightSidebarOpen, settings])

  useEffect(() => {
    // Why: if they discover the edge themselves, drop the tip so we never nag.
    if (!rightSidebarPeek) {
      return
    }
    if (!isRightSidebarEdgePeekEnabled(settings)) {
      return
    }
    clearHideTimer()
    setVisible(false)
    if (settings?.rightSidebarEdgePeekTipDismissed !== true) {
      markRightSidebarEdgePeekTipDismissed({ updateSettings: updateSettingsRef.current })
    }
  }, [rightSidebarPeek, settings])

  useEffect(() => {
    if (!isRightSidebarEdgePeekEnabled(settings) && visible) {
      clearHideTimer()
      setVisible(false)
    }
  }, [settings, visible])

  // Why: measure after paint so the closed-state titlebar toggle has laid out;
  // re-measure on resize while the tip is up so a window drag doesn't leave it
  // floating off the icon.
  useLayoutEffect(() => {
    if (!visible) {
      setAnchor(null)
      return
    }
    const update = (): void => {
      setAnchor(measureToggleAnchor())
    }
    update()
    // Titlebar toggle mounts in the same close transition; retry once if the
    // first paint still has the open-sidebar control (which unmounts).
    const retry = window.setTimeout(update, 0)
    window.addEventListener('resize', update)
    return () => {
      window.clearTimeout(retry)
      window.removeEventListener('resize', update)
    }
  }, [visible, rightSidebarOpen])

  if (!visible || !anchor) {
    return null
  }

  // Why: hang left from the toggle so a near-edge titlebar icon doesn't clip
  // the tip off-screen; caret sits under the icon center.
  const caretOffsetPx = 14
  const style: CSSProperties = {
    position: 'fixed',
    top: anchor.top + anchor.height + 8,
    left: anchor.left + anchor.width / 2 + caretOffsetPx,
    transform: 'translateX(-100%)'
  }

  const openSettings = (): void => {
    dismissVisibleTip()
    openRightSidebarEdgePeekSetting({
      openSettingsPage,
      openSettingsTarget,
      setSettingsSearchQuery
    })
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="right-sidebar-edge-peek-tip"
      style={style}
      // Why: tip is mostly non-interactive; only the Settings link receives
      // pointer events so it doesn't block titlebar clicks around the chip.
      className="pointer-events-none z-[90] w-max max-w-[280px] animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
    >
      <div className="relative rounded-md bg-foreground px-3 py-1.5 text-xs leading-snug text-background shadow-xs">
        <div>{getRightSidebarEdgePeekTipTitle()}</div>
        <div className="opacity-80">
          {getRightSidebarEdgePeekTipSettingsPrefix()}{' '}
          <button
            type="button"
            data-testid="right-sidebar-edge-peek-tip-settings-link"
            onClick={openSettings}
            // Why: the one-shot timer must not remove an actionable control
            // while a pointer or keyboard user is interacting with it.
            onPointerEnter={clearHideTimer}
            onPointerLeave={scheduleHide}
            onFocus={clearHideTimer}
            onBlur={scheduleHide}
            className="pointer-events-auto cursor-pointer font-medium underline underline-offset-2 hover:opacity-100"
          >
            {getRightSidebarEdgePeekSettingsLinkLabel()}
          </button>
        </div>
        {/* Tooltip-style caret pointing up at the toggle icon. */}
        <span
          aria-hidden
          className="absolute -top-1 size-2 rotate-45 rounded-[2px] bg-foreground"
          style={{ right: caretOffsetPx - 4 }}
        />
      </div>
    </div>
  )
}
