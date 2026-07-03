import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'
import {
  attachWebgl,
  clearTerminalWebglAttachBackoff,
  disposeWebgl,
  markComplexScriptOutput,
  resetWebglTextureAtlas
} from './pane-webgl-renderer'
import {
  retainSuspendedWebglPane,
  shouldRetainSuspendedWebglContexts,
  unretainWebglPane
} from './pane-webgl-context-retention'
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
  const retainContexts = shouldRetainSuspendedWebglContexts()
  for (const pane of panes) {
    // Why: deferred blocks NEW context creation while hidden; on Windows,
    // live contexts are retained (not disposed) so the return switch repaints
    // instantly instead of paying ANGLE context re-creation. The LRU cap
    // bounds how many hidden panes may keep one.
    pane.webglAttachmentDeferred = true
    if (!retainContexts) {
      disposeWebgl(pane)
      continue
    }
    for (const evicted of retainSuspendedWebglPane(pane)) {
      disposeWebgl(evicted)
    }
  }
}

export function resumePaneRendering(panes: Iterable<ManagedPaneInternal>): void {
  // Why: resume (worktree foreground, window wake) is the WebGL retry
  // boundary — Chromium may have restored the GPU process since a context
  // loss, and bounding retries to resume events cannot loop on live loss.
  clearTerminalWebglAttachBackoff()
  for (const pane of panes) {
    unretainWebglPane(pane)
    pane.webglAttachmentDeferred = false
    pane.webglDisabledAfterContextLoss = false
    if (pane.webglAddon) {
      // Why: recovery bursts skip suspended panes, so the shared glyph atlas
      // may have been cleared/rebuilt while this pane sat hidden with its
      // retained context. Repaint from the buffer so stale glyph coordinates
      // never reach the screen.
      try {
        if (pane.terminal.rows > 0) {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        }
      } catch {
        /* ignore — pane may be tearing down during resume */
      }
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
