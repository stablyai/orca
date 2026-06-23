import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import { resetAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'
import {
  flushTerminalOutput,
  requestTerminalBacklogRecovery
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { restoreScrollStateAfterLayout } from '@/lib/pane-manager/pane-scroll'
import { fitAndFocusPanes, fitPanes, focusActivePane } from './pane-helpers'

const VISIBLE_RESUME_FLUSH_CHARS = 256 * 1024

export type TerminalHiddenReason = 'surface' | 'tab'

type ResumeTerminalVisibilityArgs = {
  manager: PaneManager
  isActive: boolean
  wasVisible: boolean
  shouldUseLightTabResume: boolean
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
  withSuppressedScrollTracking: (callback: () => void) => void
}

type HideTerminalVisibilityArgs = {
  manager: PaneManager
  wasVisible: boolean
  wasWorktreeActive: boolean
  isWorktreeActive: boolean
  hasCompletedVisibleResume: boolean
  captureViewportPositions: (useRememberedSnapshots: boolean) => Map<number, ScrollState>
}

type HideTerminalVisibilityResult = {
  hiddenReason: TerminalHiddenReason | null
  renderingSuspended: boolean
}

export function resumeTerminalVisibility({
  manager,
  isActive,
  wasVisible,
  shouldUseLightTabResume,
  captureViewportPositions,
  withSuppressedScrollTracking
}: ResumeTerminalVisibilityArgs): void {
  // Why: WebGL resume can disturb xterm's viewport bookkeeping before the
  // post-resume fit runs. Capture numeric viewport positions first; the
  // restore path avoids content matching so duplicate agent log lines do
  // not jump to the wrong history entry.
  const viewportPositions = captureViewportPositions(!wasVisible)
  withSuppressedScrollTracking(() => {
    if (shouldUseLightTabResume) {
      // Why: intra-worktree tab switches only toggle the overlay. Keeping
      // synchronous drain and atlas rebuilds off this path avoids racing the
      // overlay's delayed geometry fit. Still request hidden-output recovery:
      // agent TUIs can suppress hidden bytes until the pane is foregrounded.
      requestLightTabBacklogRecovery(manager)
      if (isActive) {
        focusActivePane(manager)
      }
    } else {
      resumeTerminalVisibilityHeavy(manager, isActive)
    }
    restoreTerminalViewportPositions(manager, viewportPositions)
    if (!shouldUseLightTabResume) {
      // Why: this clear wipes the glyph atlas shared with other same-config
      // terminals; the global reset rebuilds their render models too.
      resetAllTerminalWebglAtlases()
    }
  })
}

export function hideTerminalVisibility({
  manager,
  wasVisible,
  wasWorktreeActive,
  isWorktreeActive,
  hasCompletedVisibleResume,
  captureViewportPositions
}: HideTerminalVisibilityArgs): HideTerminalVisibilityResult {
  const surfaceBecameHidden = wasWorktreeActive && !isWorktreeActive
  if (wasVisible) {
    // Why: hidden DOM/layout churn can mutate xterm's viewport before the
    // pane becomes visible again. Preserve the last visible position.
    captureViewportPositions(false)
  }
  if (!isWorktreeActive && (wasVisible || surfaceBecameHidden)) {
    // Suspend WebGL when going hidden. xterm.write() continues to land in
    // the (now DOM-renderer-fallback or paused-canvas) terminal; the
    // suspend is purely a GPU resource decision.
    manager.suspendRendering()
    return { hiddenReason: 'surface', renderingSuspended: true }
  }
  if (!hasCompletedVisibleResume && wasVisible && wasWorktreeActive && isWorktreeActive) {
    // Why: the visibility hook starts wasVisible=true so terminal tabs that
    // first mount hidden still release WebGL contexts instead of exhausting
    // Chromium's small context budget.
    manager.suspendRendering()
    return { hiddenReason: 'tab', renderingSuspended: true }
  }
  if (wasVisible && isWorktreeActive) {
    return { hiddenReason: 'tab', renderingSuspended: false }
  }
  if (!isWorktreeActive) {
    return { hiddenReason: 'surface', renderingSuspended: false }
  }
  return { hiddenReason: null, renderingSuspended: false }
}

function requestLightTabBacklogRecovery(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
  }
}

function resumeTerminalVisibilityHeavy(manager: PaneManager, isActive: boolean): void {
  // Why: hidden panes can accumulate large PTY bursts while Chromium is
  // occluded. Drain a bounded slice before fitting; the scheduler keeps
  // ordering and continues the rest asynchronously so return-to-app does
  // not beachball behind an entire backlog.
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: VISIBLE_RESUME_FLUSH_CHARS })
  }
  // Resume WebGL immediately so the terminal shows its last-known state
  // on the first painted frame. macOS context creation is ~5 ms; on
  // Windows (ANGLE -> D3D11) it can be 100-500 ms but a deferred resume
  // would paint a stretched DOM-fallback flash, which is worse UX.
  manager.resumeRendering()
  // Single fit on resume. Background bytes have been pushed into xterm
  // above, so this fit only absorbs container dimension changes that
  // happened while hidden (e.g. sidebar toggle on another worktree).
  if (isActive) {
    fitAndFocusPanes(manager)
  } else {
    fitPanes(manager)
  }
}

function restoreTerminalViewportPositions(
  manager: PaneManager,
  viewportPositions: Map<number, ScrollState>
): void {
  for (const pane of manager.getPanes()) {
    const position = viewportPositions.get(pane.id)
    if (position) {
      restoreScrollStateAfterLayout(pane.terminal, position)
    }
  }
}
