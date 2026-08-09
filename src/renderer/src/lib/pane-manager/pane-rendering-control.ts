import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'
import {
  attachWebgl,
  clearTerminalWebglAttachBackoff,
  disposeWebgl,
  isTerminalWebglRetryPinnedAfterContextLosses,
  markComplexScriptOutput,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'

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

export function suspendPaneRendering(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    pane.webglAttachmentDeferred = true
    disposeWebgl(pane)
  }
}

/** Re-enable WebGL rendering at a resume boundary (worktree foreground,
 *  window wake), except for panes pinned to the DOM renderer by their
 *  context-loss budget. */
export function resumePaneRendering(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    // Why: resume (worktree foreground, window wake) is the WebGL retry
    // boundary — Chromium may have restored the GPU process since a context
    // loss, and bounding retries to resume events cannot loop on live loss.
    clearTerminalWebglAttachBackoff(pane)
    pane.webglAttachmentDeferred = false
    // Why the pin check: resumes fire on every worktree switch, so an
    // unconditional clear re-attached WebGL to panes whose contexts Chromium
    // keeps reclaiming — churning WebGL↔DOM per switch and re-arming the
    // stale-canvas desync behind issue #12452. A pane over its loss budget
    // stays on the DOM renderer until the loss window decays.
    if (!isTerminalWebglRetryPinnedAfterContextLosses(pane)) {
      pane.webglDisabledAfterContextLoss = false
    }
    reattachWebglIfNeeded(pane)
  }
}

export function resetPaneWebglTextureAtlases(panes: Iterable<ManagedPaneInternal>): void {
  for (const pane of panes) {
    resetWebglTextureAtlas(pane)
  }
}
