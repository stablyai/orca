import type { ManagedPaneInternal } from './pane-manager-types'
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
import { rebuildAttachedWebgl, reattachWebglIfNeeded } from './pane-webgl-reattach'
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
  for (const pane of suspended) {
    pane.webglAttachmentDeferred = true
  }
  // Keep recent hidden worktrees on live WebGL so switch-back never presents
  // DOM-fallback frames; evicted/over-cap owners fall back to dispose.
  if (retention && tryRetainHiddenPanesWebgl(retention.owner, retention.livePanes)) {
    // Why: retained WebGL keeps xterm's focused cursor timer alive behind the hidden surface.
    for (const pane of suspended) {
      pane.terminal.blur()
    }
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
    // Why: resume (worktree foreground, window wake) is the WebGL retry
    // boundary — Chromium may have restored the GPU process since a context
    // loss, and bounding retries to resume events cannot loop on live loss.
    clearTerminalWebglAttachBackoff(pane)
    const rebuildDeferred = pane.webglRebuildDeferred === true
    pane.webglAttachmentDeferred = false
    pane.webglDisabledAfterContextLoss = false
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
