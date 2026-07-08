import { memo, useEffect, useRef } from 'react'
import { noteTerminalPaneVisibility } from './terminal-pane-eviction-coordinator'

// STA-1282: the eviction visibility report MUST come from a component that
// survives the mount gate. The gated overlay slot unmounts the instant a pane
// goes hidden-and-not-yet-warm, so reporting from inside it deadlocks (a pane
// can't warm without reporting hidden, and can't report hidden without staying
// mounted). This reporter is rendered by the overlay layer for EVERY terminal
// tab — visible, warm, evicted, or never-visited — so the visible->hidden
// transition is always reported before/without unmounting anything.
//
// It is edge-honest: a tab that has never been visible does NOT report hidden
// (that would warm every background tab and defeat the mount-storm fix); only a
// tab that was visible reports the hide. Flag-OFF inertness: with eviction
// disabled it does nothing (the coordinator also self-guards), so it is
// byte-identical to the pre-eviction app; enabling at runtime reactivates via
// the next visible report.
export const TerminalPaneVisibilityReporter = memo(function TerminalPaneVisibilityReporter({
  terminalTabId,
  worktreeId,
  effectiveVisible,
  evictionEnabled
}: {
  terminalTabId: string
  worktreeId: string
  effectiveVisible: boolean
  evictionEnabled: boolean
}): null {
  const hasBeenVisibleRef = useRef(false)
  useEffect(() => {
    if (!evictionEnabled) {
      return
    }
    if (effectiveVisible) {
      hasBeenVisibleRef.current = true
      noteTerminalPaneVisibility(terminalTabId, worktreeId, true)
      return
    }
    // Only report the visible->hidden transition. A never-visited hidden tab
    // must stay Tier-2 unmounted (no warm entry, no PTY spawn).
    if (hasBeenVisibleRef.current) {
      noteTerminalPaneVisibility(terminalTabId, worktreeId, false)
    }
  }, [evictionEnabled, effectiveVisible, terminalTabId, worktreeId])
  return null
})
