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
import { useAppStore } from '@/store'
import { auditPaneWeightParity } from './terminal-render-desync-weight-probe'
import { flushDeferredPaneMetricOptionsIfMeasurable } from '@/lib/pane-manager/pane-fit'
import { repairPaneWebglCanvasDprMismatch } from '@/lib/pane-manager/terminal-canvas-dpr-repair'
import { presentPaneViewport } from '@/lib/pane-manager/pane-webgl-renderer'

const VISIBLE_RESUME_FLUSH_CHARS = 256 * 1024
const WINDOW_WAKE_FLUSH_CHARS = 64 * 1024

export type TerminalHiddenReason = 'surface' | 'tab'

type ResumeTerminalVisibilityArgs = {
  manager: PaneManager
  isActive: boolean
  isChatViewMode: boolean
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
  isChatViewMode: boolean
  clearGlyphAtlases: boolean
}

export function resumeTerminalVisibility({
  manager,
  isActive,
  isChatViewMode,
  wasVisible,
  shouldUseLightTabResume,
  captureViewportPositions,
  withSuppressedScrollTracking
}: ResumeTerminalVisibilityArgs): void {
  // Hiding clears the active link but leaves hover-cell cache; reset or a stationary pointer’s link stays dead until scroll.
  for (const pane of manager.getPanes()) {
    resetTerminalLinkifierHoverState(pane.terminal)
  }
  syncTerminalViewportIntents(manager)
  // Capture numeric viewport position before WebGL resume; text matching can jump among duplicate agent log lines.
  captureViewportPositions(!wasVisible)
  let repairedDpr = false
  withSuppressedScrollTracking(() => {
    if (shouldUseLightTabResume) {
      let flushedDeferredMetrics = false
      for (const pane of manager.getPanes()) {
        if (flushDeferredPaneMetricOptionsIfMeasurable(pane)) {
          flushedDeferredMetrics = true
        }
        // Light reveal otherwise has no renderer/fit repair for hidden-time DPR changes.
        repairPaneWebglCanvasDprMismatch(pane)
      }
      auditPaneWeightParity(manager.getPanes(), useAppStore.getState().settings)
      // Keep drain/atlas rebuild off overlay-only switches to avoid fit races, but still recover bytes suppressed by hidden TUIs.
      requestLightTabBacklogRecovery(manager)
      if (flushedDeferredMetrics) {
        // Flushed metrics changed cell size; light reveal must refit despite normally skipping fit.
        manager.fitAllRevealedPanes()
      }
      if (isActive && !isChatViewMode) {
        focusActivePane(manager)
      }
    } else {
      // Flush after WebGL attachment to avoid a redundant suspended-DOM refresh while preserving first paint.
      repairedDpr = resumeTerminalVisibilityHeavy(manager, isActive && !isChatViewMode)
    }
    enforceTerminalViewportIntents(manager)
    if (!shouldUseLightTabResume) {
      auditPaneWeightParity(manager.getPanes(), useAppStore.getState().settings)
    }
    if (shouldUseLightTabResume) {
      // Preserve coherent DEC-2026 frames; settled refresh arms xterm’s watchdog without clearing shared GPU data.
      manager.scheduleRevealPresent()
    } else if (repairedDpr) {
      // DPR-stale atlas glyphs cannot wait two frames; rebuild before paint.
      resetAndRefreshAllTerminalWebglAtlases('visibility-resume-dpr')
      manager.scheduleRevealRepaint()
    } else {
      // Hidden parsing changes the model without presenting; force present now or unchanged-cell diff retains pre-hide pixels until settled rebuild.
      for (const pane of manager.getPanes()) {
        presentPaneViewport(pane)
      }
      // Rebuild once after attachment/measurement instead of paying a duplicate global atlas reset.
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
    // Hidden DOM/layout churn can move viewport; retain the last visible position.
    captureViewportPositions(false)
  }
  if (!isWorktreeActive && (wasVisible || surfaceBecameHidden)) {
    // xterm.write() keeps updating the hidden buffer; suspension only changes renderer lifetime.
    manager.suspendRendering()
    return { hiddenReason: 'surface', renderingSuspended: true }
  }
  if (!hasCompletedVisibleResume && wasVisible && wasWorktreeActive && isWorktreeActive) {
    // Initially hidden tabs must still suspend WebGL or exhaust Chromium’s limited context budget.
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
  isChatViewMode,
  clearGlyphAtlases
}: RecoverVisibleTerminalWindowWakeArgs): void {
  // Display wake can leave visible xterm renderer/input stale without triggering hidden-state resume.
  syncTerminalViewportIntents(manager)
  for (const pane of manager.getPanes()) {
    // Undock/monitor moves can change DPR without box changes the addon detects; repair on wake/refocus too.
    if (repairPaneWebglCanvasDprMismatch(pane)) {
      presentPaneViewport(pane)
    }
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: WINDOW_WAKE_FLUSH_CHARS })
    // Blur leaves stale hover-cell cache; reset on refocus unless a hovered link would flicker.
    if (!isTerminalLinkifierHoverActive(pane.terminal)) {
      resetTerminalLinkifierHoverState(pane.terminal)
    }
  }
  manager.resumeRendering()
  // Why: wake re-attaches WebGL — same transient cell-metric wobble guard as the heavy resume.
  manager.fitAllRevealedPanes()
  if (isActive && !isChatViewMode) {
    focusActivePane(manager)
  }
  enforceTerminalViewportIntents(manager)
  if (clearGlyphAtlases) {
    // Only real wake may clear the shared atlas: concurrent rasterization can lose xterm’s single-consumer clear-model flag and garble siblings (#4480).
    resetAndRefreshAllTerminalWebglAtlases('system-resume')
    manager.scheduleRevealRepaint()
  } else {
    // Plain refocus must present without shared-atlas reset or it reopens the streaming garble race.
    manager.scheduleRevealPresent()
  }
}

function requestLightTabBacklogRecovery(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
  }
}

function resumeTerminalVisibilityHeavy(manager: PaneManager, shouldFocus: boolean): boolean {
  // Drain only a bounded pre-fit backlog slice; keep ordering and continue asynchronously to avoid freezing app return.
  for (const pane of manager.getPanes()) {
    requestTerminalBacklogRecovery(pane.terminal)
    flushTerminalOutput(pane.terminal, { maxChars: VISIBLE_RESUME_FLUSH_CHARS })
  }
  // Intent was latched by the caller before queued writes can expose transient geometry.
  // Resume WebGL before first paint to avoid stretched DOM fallback, despite slower Windows context creation.
  manager.resumeRendering()
  // Unchanged grid can still have stale backing-store DPR; repair before final shared-atlas presentation.
  let repairedDpr = false
  for (const pane of manager.getPanes()) {
    if (repairPaneWebglCanvasDprMismatch(pane)) {
      repairedDpr = true
    }
  }
  // Guard post-WebGL fit against transient DOM/WebGL one-column mismatch that reflows and garbles inline TUIs.
  manager.fitAllRevealedPanes()
  if (shouldFocus) {
    focusActivePane(manager)
  }
  return repairedDpr
}

function enforceTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    enforceTerminalCurrentScrollIntent(pane.terminal)
  }
}

function syncTerminalViewportIntents(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    // Capture content-stable pinned viewport after native trimming but before resume/fit can disturb it.
    syncTerminalScrollIntentFromViewport(pane.terminal)
  }
}
