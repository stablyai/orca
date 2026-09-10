import type { ManagedPaneInternal } from './pane-manager-types'
import {
  resumeTerminalCursorBlink,
  suspendTerminalCursorBlink
} from './pane-cursor-blink-suspension'
import { safeFit } from './pane-tree-ops'
import {
  attachWebgl,
  clearTerminalWebglAttachBackoff,
  disposeWebgl,
  isPaneWebglContextLost,
  markComplexScriptOutput,
  clearWebglTextureAtlas,
  presentPaneViewport,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'
import {
  clearPaneWebglContextLossForRetry,
  rebuildAttachedWebgl,
  reattachWebglIfNeeded
} from './pane-webgl-reattach'
import {
  releaseHiddenWebglRetention,
  tryRetainHiddenPanesWebgl
} from './terminal-webgl-hidden-retention'

export function setPaneGpuRenderingState(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number,
  enabled: boolean
): void {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  pane.gpuRenderingEnabled = enabled
  if (!enabled) {
    disposeWebgl(pane, { refreshDimensions: true })
    return
  }
  if (pane.webglAttachmentDeferred || pane.webglDisabledAfterContextLoss) {
    return
  }
  if (!pane.webglAddon) {
    attachWebgl(pane)
    safeFit(pane)
  }
}

export function markPaneComplexScriptOutput(
  panes: Map<number, ManagedPaneInternal>,
  paneId: number
): void {
  const pane = panes.get(paneId)
  if (pane) {
    markComplexScriptOutput(pane)
  }
}

export function suspendPaneRendering(
  panes: Iterable<ManagedPaneInternal>,
  retention?: { owner: object; livePanes: () => Iterable<ManagedPaneInternal> }
): void {
  const suspended = Array.from(panes)
  // Why: both branches must leave a suspended pane in the same state; only the retention
  // branch below used to blur. Defence in depth, not a measured cost — display:none and
  // inert both make Chromium blur the pane itself, and disposeWebgl kills the blink timer
  // regardless. It only bites under opacity:0 without inert (TerminalOverlaySlot's startup
  // probe), the one hide mode that keeps focus.
  for (const pane of suspended) {
    pane.webglAttachmentDeferred = true
    pane.terminal.blur()
    // Why here, above the retention return: the retention branch keeps a live
    // WebglRenderer, whose blink timer only stops on a real DOM blur event. blur()
    // above is a no-op unless that pane's textarea held focus, so under a hide mode
    // that keeps focus the pane would blink — redrawing its cursor row — until the
    // 5-minute idle timeout. Parking the option makes it unconditional.
    suspendTerminalCursorBlink(pane.terminal)
  }
  // Keep recent hidden worktrees on live WebGL so switch-back never presents
  // DOM-fallback frames; evicted/over-cap owners fall back to dispose.
  if (retention && tryRetainHiddenPanesWebgl(retention.owner, retention.livePanes)) {
    return
  }
  for (const pane of suspended) {
    disposeWebgl(pane)
  }
}

export function resumePaneRendering(
  panes: Iterable<ManagedPaneInternal>,
  retentionOwner?: object
): void {
  if (retentionOwner) {
    releaseHiddenWebglRetention(retentionOwner)
  }
  for (const pane of panes) {
    clearTerminalWebglAttachBackoff(pane)
    // Before the attach below so a freshly constructed WebglRenderer already samples
    // the restored option and blinks on its first frame.
    resumeTerminalCursorBlink(pane.terminal)
    const rebuildDeferred = pane.webglRebuildDeferred === true
    pane.webglAttachmentDeferred = false
    // Reveal can retry before the next resume, so both paths share the bounded loss policy.
    clearPaneWebglContextLossForRetry(pane)
    pane.webglRebuildDeferred = false
    if (pane.webglAddon && isPaneWebglContextLost(pane)) {
      disposeWebgl(pane)
    }
    if (rebuildDeferred && pane.webglAddon) {
      rebuildAttachedWebgl(pane)
      continue
    }
    reattachWebglIfNeeded(pane)
  }
}

export function resetPaneWebglTextureAtlases(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    resetWebglTextureAtlas(pane)
  }
}

export function clearPaneWebglTextureAtlases(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    clearWebglTextureAtlas(pane)
  }
}

export function presentPaneViewports(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    presentPaneViewport(pane)
  }
}
