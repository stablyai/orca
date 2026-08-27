import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'
import { resetAndRefreshAllTerminalWebglAtlases } from '@/lib/pane-manager/pane-manager-registry'
import {
  flushTerminalOutput,
  requestTerminalBacklogRecovery
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import {
  enforceTerminalCurrentScrollIntent,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
import {
  isTerminalLinkifierHoverActive,
  resetTerminalLinkifierHoverState
} from '@/lib/pane-manager/terminal-linkifier-hover-reset'
import { focusActivePane } from './pane-helpers'
import { flushDeferredPaneMetricOptionsIfMeasurable } from '@/lib/pane-manager/pane-fit'
import { repairPaneWebglCanvasDprMismatch } from '@/lib/pane-manager/terminal-canvas-dpr-repair'
import { presentPaneViewport } from '@/lib/pane-manager/pane-webgl-renderer'

const VISIBLE_RESUME_FLUSH_CHARS = 256 * 1024
const WINDOW_WAKE_FLUSH_CHARS = 64 * 1024

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

type RecoverVisibleTerminalWindowWakeArgs = {
  manager: PaneManager
  isActive: boolean
  clearGlyphAtlases: boolean
}

export function resumeTerminalVisibility({
  manager,
  isActive,
  wasVisible,
  shouldUseLightTabResume,
  captureViewportPositions,
  withSuppressedScrollTracking
}: ResumeTerminalVisibilityArgs): void {
  // Why: hiding the surface fired mouseleave, which cleared xterm's current
  // link but left its hover cell cache; without this reset a link stays dead
  // until a scroll when the pointer returns to the same cell on reveal.
  for (const pane of manager.getPanes()) {
    resetTerminalLinkifierHoverState(pane.terminal)
  }
  syncTerminalViewportIntents(manager)
  // Why: WebGL resume can disturb xterm's viewport bookkeeping before the
  // post-resume fit runs. Capture numeric viewport positions first; the
  // restore path avoids content matching so duplicate agent log lines do
  // not jump to the wrong history entry.
  captureViewportPositions(!wasVisible)
  withSuppressedScrollTracking(() => {
    if (shouldUseLightTabResume) {
      let flushedDeferredMetrics = false
      for (const pane of manager.getPanes()) {
        if (flushDeferredPaneMetricOptionsIfMeasurable(pane)) {
          flushedDeferredMetrics = true
        }
        // Why here: the light path neither recreates WebGL nor fits, so a dpr
        // change that landed while this tab was hidden has no other repair point.
        repairPaneWebglCanvasDprMismatch(pane)
      }
      // Why: intra-worktree tab switches only toggle the overlay. Keeping
      // synchronous drain and atlas rebuilds off this path avoids racing the
      // overlay's delayed geometry fit. Still request hidden-output recovery:
      // agent TUIs can suppress hidden bytes until the pane is foregrounded.
      requestLightTabBacklogRecovery(manager)
      if (flushedDeferredMetrics) {
        // Why: the light path normally skips fitting, but flushed metrics changed
        // cell size — refit so cols/rows match before the overlay settles.
        manager.fitAllRevealedPanes()
      }
      if (isActive) {
        focusActivePane(manager)
      }
    } else {
      // fitAllRevealedPanes flushes after WebGL reattaches, avoiding a redundant
      // full refresh in the suspended DOM renderer while preserving first paint.
      resumeTerminalVisibilityHeavy(manager, isActive)
    }
    enforceTerminalViewportIntents(manager)
    if (!shouldUseLightTabResume) {
      // Why: this clear wipes the glyph atlas shared with other same-config
      // terminals; refresh after reset so rebuilt atlases repaint from xterm.
      resetAndRefreshAllTerminalWebglAtlases('visibility-resume')
    }
    if (shouldUseLightTabResume) {
      // Why: preserve the last coherent frame while a TUI holds DEC 2026. The
      // settled refresh arms xterm's watchdog without clearing shared GPU data.
      manager.scheduleRevealPresent()
    } else {
      // Why: rendering was recreated, so the heavy path still needs the proven
      // shared-atlas recovery after layout settles.
      manager.scheduleRevealRepaint()
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
    // xterm.write() keeps updating the hidden buffer; suspension only changes renderer lifetime.
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

export function recoverVisibleTerminalWindowWake({
  manager,
  isActive,
  clearGlyphAtlases
}: RecoverVisibleTerminalWindowWakeArgs): void {
  // Why: macOS screensaver/display wake can leave xterm visible but with a
  // stale renderer/input surface; Orca's own hidden-state resume never runs.
  // Why: backlog writes can expose transient viewport geometry while parsing.
  syncTerminalViewportIntents(manager)
  for (const pane of manager.getPanes()) {
    // Why: clamshell undock / monitor move changes devicePixelRatio while the
    // pane can stay "visible" with a stale WebGL backing store. The addon's
    // device-pixel observer misses that (no CSS-box change, or no box while
    // the lid was closed). Repair here — not only on tab reveal.
    if (repairPaneWebglCanvasDprMismatch(pane)) {
      presentPaneViewport(pane)
    }
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: WINDOW_WAKE_FLUSH_CHARS })
    // Why: window blur fires mouseleave, clearing xterm's current link but not
    // its hover cell cache; on refocus the stationary pointer sits on the same
    // cell, so the link stays dead until a scroll. Skip while a link is hovered
    // to avoid flickering its underline (same guard as the on-write reset).
    if (!isTerminalLinkifierHoverActive(pane.terminal)) {
      resetTerminalLinkifierHoverState(pane.terminal)
    }
  }
  manager.resumeRendering()
  // Why: wake re-attaches WebGL — same transient cell-metric wobble guard as the heavy resume.
  manager.fitAllRevealedPanes()
  if (isActive) {
    focusActivePane(manager)
  }
  enforceTerminalViewportIntents(manager)
  if (clearGlyphAtlases) {
    // Why: only a genuine wake may wipe the shared glyph atlas. The wipe makes
    // every same-config pane re-rasterize at once, and xterm's atlas page-merge
    // clear-model flag is consumed by one renderer (xterm.js #4480), so panes
    // that lose that race paint garbled glyphs mid-stream.
    resetAndRefreshAllTerminalWebglAtlases('system-resume')
    manager.scheduleRevealRepaint()
  } else {
    // Why: the reveal repaint runs a shared-atlas reset, so a plain refocus
    // must use the atlas-preserving present instead — otherwise it re-arms the
    // same mid-stream garble race.
    manager.scheduleRevealPresent()
  }
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
  // Intent was latched by the caller before queued writes can expose transient geometry.
  // Resume WebGL immediately so the terminal shows its last-known state
  // on the first painted frame. macOS context creation is ~5 ms; on
  // Windows (ANGLE -> D3D11) it can be 100-500 ms but a deferred resume
  // would paint a stretched DOM-fallback flash, which is worse UX.
  manager.resumeRendering()
  // Why: unchanged grid geometry can skip the reveal fit, but a retained WebGL
  // canvas may still carry the previous display's backing-store DPR. The
  // caller's atlas recovery presents the final shared-atlas generation.
  for (const pane of manager.getPanes()) {
    repairPaneWebglCanvasDprMismatch(pane)
  }
  // Why: resumeRendering just re-attached WebGL, whose cell metrics briefly differ
  // from the DOM renderer's; a raw fit here reflows on a transient one-column-off
  // grid and garbles diff-painting inline TUIs (grok minimize→restore).
  manager.fitAllRevealedPanes()
  if (isActive) {
    focusActivePane(manager)
  }
}

function enforceTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    enforceTerminalCurrentScrollIntent(pane.terminal)
  }
}

function syncTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    // Why: native scrollback trimming moves a pinned viewport content-stably.
    // Capture that live position before resume/fit can disturb it.
    syncTerminalScrollIntentFromViewport(pane.terminal)
  }
}
