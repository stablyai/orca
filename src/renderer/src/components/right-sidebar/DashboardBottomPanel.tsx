import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import AgentDashboard from '../dashboard/AgentDashboard'

const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 220
const HEADER_HEIGHT = 28
// Why: leave room for the tab content above the dashboard — used in both the drag max and the layout-effect measure, must stay in sync.
const RESERVED_ABOVE_PX = 160
const STORAGE_KEY = 'orca.dashboardSidebarPanel'

type PersistedState = {
  height: number
  collapsed: boolean
}

function loadPersistedState(): PersistedState {
  if (typeof window === 'undefined') {
    return { height: DEFAULT_HEIGHT, collapsed: false }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { height: DEFAULT_HEIGHT, collapsed: false }
    }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    // Why: stale or tampered localStorage can hold NaN, negative, zero, or
    // absurdly large heights. The runtime clamp in onResizeMove only fires
    // during an active drag, so without validation here the initial render
    // can produce a zero-height strip or a panel that eats the whole sidebar
    // before the user ever touches the resize handle. We can't clamp the
    // upper bound yet (sidebarHeight isn't known until mount), but enforcing
    // finite + MIN_HEIGHT eliminates the worst-case visual breakage.
    const rawHeight =
      typeof parsed.height === 'number' && Number.isFinite(parsed.height)
        ? parsed.height
        : DEFAULT_HEIGHT
    return {
      height: Math.max(MIN_HEIGHT, rawHeight),
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : false
    }
  } catch {
    return { height: DEFAULT_HEIGHT, collapsed: false }
  }
}

// Why: a persistent bottom section of the right sidebar that always shows the
// agent dashboard, independent of which activity tab the user has open. The
// user drags the top edge to resize upward and can fully collapse to a
// single header row.
export default function DashboardBottomPanel(): React.JSX.Element {
  // Why: read localStorage once per mount; multi-window state diverges intentionally.
  const initial = useMemo(loadPersistedState, [])
  const [height, setHeight] = useState<number>(initial.height)
  const [collapsed, setCollapsed] = useState<boolean>(initial.collapsed)
  // Why: tracks the sidebar-derived upper bound used to clamp rendering only.
  // We deliberately keep this separate from `height` so the user's persisted
  // preference is never overwritten by a transient small-window measurement
  // (see the useLayoutEffect below for the full rationale).
  const [measuredMaxHeight, setMeasuredMaxHeight] = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const resizeStateRef = useRef<{
    startY: number
    startHeight: number
    maxHeight: number
  } | null>(null)

  // Why: mirror `height`/`collapsed` into refs so callbacks and the unmount
  // flush can read the latest value without being re-created on every change.
  // `onResizeStart` previously listed `height` in its deps, which meant every
  // mousemove (which calls setHeight) recreated the callback — pure waste on
  // the hot drag path. Refs keep the callback identity stable.
  const heightRef = useRef(height)
  const collapsedRef = useRef(collapsed)
  useEffect(() => {
    heightRef.current = height
  }, [height])
  useEffect(() => {
    collapsedRef.current = collapsed
  }, [collapsed])

  // Why: persist height + collapsed via localStorage (renderer-only) so the
  // layout survives reloads. Debounce writes so continuous drag doesn't spam.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ height, collapsed }))
      } catch {
        // ignore quota / privacy-mode errors
      }
    }, 150)
    return () => window.clearTimeout(timer)
  }, [height, collapsed])

  // Why: the debounced write above clears its pending timeout on every deps
  // change AND on unmount — so the user's final drag value is lost if the
  // component unmounts within the 150ms debounce window (hot reload, hiding
  // the dashboard, closing the window). This separate mount-lifecycle effect
  // has empty deps, so its cleanup runs ONLY on true unmount (never on deps
  // re-run), and it flushes the latest values synchronously to localStorage.
  // Reading via refs ensures we write the final state, not a stale snapshot.
  useEffect(() => {
    return () => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ height: heightRef.current, collapsed: collapsedRef.current })
        )
      } catch {
        // ignore quota / privacy-mode errors
      }
    }
    // Why: empty deps are intentional — adding [height, collapsed] would turn
    // this unmount-only flush into a per-change write, defeating the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onResizeMove = useCallback((event: MouseEvent) => {
    const state = resizeStateRef.current
    if (!state) {
      return
    }
    const deltaY = state.startY - event.clientY
    const next = Math.max(MIN_HEIGHT, Math.min(state.maxHeight, state.startHeight + deltaY))
    setHeight(next)
  }, [])

  // Why: keyboard support for the resize separator is required for a11y —
  // pointer-only resize locks out keyboard and assistive-tech users. Mirrors
  // the clamp logic in onResizeMove (MIN_HEIGHT lower, measuredMaxHeight
  // upper) so arrow/Home/End nudges obey the same bounds as mouse drags.
  // Step sizes (10px default, 40px with Shift) match common separator-widget
  // conventions for coarse vs. fine adjustment.
  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 10
      const upperBound = measuredMaxHeight
      const clamp = (value: number): number => {
        const lowered = Math.max(MIN_HEIGHT, value)
        return upperBound !== null ? Math.min(upperBound, lowered) : lowered
      }
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault()
          setHeight((prev) => clamp(prev + step))
          break
        case 'ArrowDown':
          event.preventDefault()
          setHeight((prev) => clamp(prev - step))
          break
        case 'Home':
          event.preventDefault()
          setHeight(MIN_HEIGHT)
          break
        case 'End':
          if (upperBound !== null) {
            event.preventDefault()
            setHeight(upperBound)
          }
          break
        default:
          break
      }
    },
    [measuredMaxHeight]
  )

  const onResizeEnd = useCallback(() => {
    resizeStateRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', onResizeEnd)
  }, [onResizeMove])

  const onResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      // Why: no `collapsed` guard here — the resize handle is only rendered
      // when `!collapsed` (see below), so this callback is unreachable while
      // collapsed. Keeping a `setCollapsed(false)` branch would be dead code
      // and would mislead future readers into thinking the handle can fire
      // in the collapsed state.
      // Why: cap expansion so the dashboard can't push the active panel
      // content to a zero-height strip. Leave 160px for the panel above.
      const sidebarEl = containerRef.current?.parentElement
      const sidebarHeight = sidebarEl?.getBoundingClientRect().height ?? 800
      const maxHeight = Math.max(MIN_HEIGHT, sidebarHeight - RESERVED_ABOVE_PX)
      resizeStateRef.current = {
        startY: event.clientY,
        // Why: use the CLAMPED height, not the raw persisted value. If the
        // stored height exceeds the current sidebar max (e.g. reopening in a
        // smaller window), the panel renders at `maxHeight` but drag math
        // would start from the raw value, so the handle appears unresponsive
        // until the cursor travels the difference. Clamping here keeps the
        // drag feel 1:1 with what's on screen.
        startHeight: Math.min(heightRef.current, maxHeight),
        maxHeight
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onResizeMove)
      window.addEventListener('mouseup', onResizeEnd)
    },
    // Why: `height` intentionally omitted — we read it via `heightRef` so the
    // callback identity stays stable during a drag. Including `height` would
    // recreate this callback on every mousemove (see heightRef declaration).
    [onResizeMove, onResizeEnd]
  )

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onResizeMove)
      window.removeEventListener('mouseup', onResizeEnd)
      // Why: if the component unmounts mid-drag (e.g. user hides the
      // dashboard from settings while dragging, or a hot-reload swaps the
      // tree), onResizeEnd never fires. Without this restore, document.body
      // would stay stuck on `row-resize` with text selection disabled
      // app-wide until the next full reload.
      if (resizeStateRef.current !== null) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
  }, [onResizeMove, onResizeEnd])

  // Why: complements the lower-bound clamp in loadPersistedState. At load
  // time we can't compute the sidebar's max height because the parent isn't
  // measured yet, so a persisted `height` of e.g. 99999 (from a prior absurd
  // drag, a browser dimension change, or tampering) would render taller than
  // the entire sidebar, pushing the active panel (Explorer/Search/
  // SourceControl) to zero height and placing the resize handle off-screen
  // where the user can't easily recover.
  //
  // CRITICAL: we measure to clamp for RENDERING only, and NEVER overwrite
  // the persisted `height` preference. An earlier version called
  // `setHeight((prev) => Math.min(prev, max))` here, which caused a nasty
  // regression: a user who had dragged to 500px in a large window and later
  // opened the app in a smaller window would have their stored preference
  // silently shrunk (via the debounced localStorage-write effect) to whatever
  // `max` happened to be. Resizing the window back up would NOT restore the
  // original 500px — the preference was gone. By storing the measurement in
  // a separate `measuredMaxHeight` state and clamping only at render time,
  // the user's intent survives every window-size change.
  //
  // useLayoutEffect (not useEffect) runs before first paint to avoid a
  // visual flash of an oversized panel. The window-resize listener keeps
  // the clamp adaptive when the user shrinks the window after mount; it
  // MUST only update `measuredMaxHeight`, never `height`.
  useLayoutEffect(() => {
    const measure = (): void => {
      const sidebarEl = containerRef.current?.parentElement
      const sidebarHeight = sidebarEl?.getBoundingClientRect().height
      if (typeof sidebarHeight !== 'number' || !Number.isFinite(sidebarHeight)) {
        return
      }
      const max = Math.max(MIN_HEIGHT, sidebarHeight - RESERVED_ABOVE_PX)
      setMeasuredMaxHeight(max)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
    }
  }, [])

  const effectiveHeight = collapsed
    ? HEADER_HEIGHT
    : measuredMaxHeight !== null
      ? Math.min(height, measuredMaxHeight)
      : height

  return (
    <div
      ref={containerRef}
      className="relative flex shrink-0 flex-col border-t border-border bg-sidebar"
      style={{ height: effectiveHeight }}
    >
      {/* Resize handle — hidden while collapsed so the user must expand first.
          Why: exposed as role="separator" with keyboard support (Arrow keys,
          Home/End) so keyboard and assistive-tech users can resize the panel.
          Without tabIndex + onKeyDown a mouse-only drag handle is an a11y gap:
          sighted keyboard users (and screen-reader users navigating widgets)
          would have no way to adjust the split. aria-value* advertises the
          current height and its bounds to assistive tech. */}
      {!collapsed && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          // Why: advertise the clamped rendered height, not the raw persisted value — otherwise valuenow can exceed valuemax when the persisted preference is larger than the current sidebar.
          aria-valuenow={Math.round(effectiveHeight)}
          aria-valuemin={MIN_HEIGHT}
          // Why: WAI-ARIA best practice is to always expose a finite range
          // alongside aria-valuenow so assistive tech can announce a
          // consistent bound. `measuredMaxHeight` is null until the
          // useLayoutEffect runs on mount, so fall back to the current
          // rendered `height` — it's guaranteed finite and correctly
          // represents the max the user can currently observe (valuenow ==
          // valuemax pre-measurement), avoiding an omitted upper bound.
          aria-valuemax={measuredMaxHeight ?? height}
          className="absolute left-0 right-0 z-10 -mt-[3px] h-[6px] cursor-row-resize transition-colors hover:bg-ring/20 active:bg-ring/30"
          onMouseDown={onResizeStart}
          onKeyDown={onResizeKeyDown}
          aria-label="Resize dashboard panel"
        />
      )}

      {/* Header: title + collapse toggle (click anywhere to toggle).
          Why: the entire header is a single <button> rather than a <div>
          wrapping a nested <button>. Nesting interactive elements is invalid
          HTML and breaks screen readers — previously the inner button had no
          onClick of its own and relied on click bubbling to the div, so
          assistive tech announced a button that appeared to do nothing. */}
      <button
        type="button"
        className="flex w-full shrink-0 select-none items-center gap-1 px-2 text-left"
        style={{ height: HEADER_HEIGHT }}
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand dashboard' : 'Collapse dashboard'}
      >
        <span className="flex h-5 w-5 items-center justify-center text-muted-foreground">
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Agents
        </span>
      </button>

      {/* Body: full AgentDashboard */}
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <AgentDashboard />
        </div>
      )}
    </div>
  )
}
