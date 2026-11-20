import type { ManagedPaneInternal } from '../pane-manager-types'
import { attachWebgl, clearTerminalWebglAttachBackoff, disposeWebgl } from './pane-webgl-renderer'
import { canRetryPaneWebglAfterContextLoss } from './pane-webgl-context-loss-policy'
import {
  setTerminalWebglAtlasRebuilder,
  takeCoveredDetachedPane
} from './terminal-webgl-atlas-memory-rebuild'
import { isXtermInstanceDisposed } from '../terminal-output/xterm-instance-disposed'
import { paintReplacementCanvasNow } from './terminal-render-pause-release'

export function clearPaneWebglContextLossForRetry(pane: ManagedPaneInternal): boolean {
  if (!pane.webglDisabledAfterContextLoss) {
    return true
  }
  if (!canRetryPaneWebglAfterContextLoss(pane)) {
    return false
  }
  pane.webglDisabledAfterContextLoss = false
  return true
}

export function reattachWebglIfNeeded(pane: ManagedPaneInternal): void {
  if (pane.gpuRenderingEnabled && !pane.webglAddon && clearPaneWebglContextLossForRetry(pane)) {
    attachWebgl(pane)
  }
}

function reattachDetachedWebgl(pane: ManagedPaneInternal): void {
  // A live addon proves context creation works; clear stale attach backoff instead of downgrading to DOM.
  clearTerminalWebglAttachBackoff(pane)
  attachWebgl(pane)
}

export function rebuildAttachedWebgl(pane: ManagedPaneInternal): void {
  if (!pane.webglAddon || pane.webglDisabledAfterContextLoss) {
    return
  }
  if (pane.webglAttachmentDeferred) {
    pane.webglRebuildDeferred = true
    return
  }
  pane.webglRebuildDeferred = false
  disposeWebgl(pane)
  reattachDetachedWebgl(pane)
}

/** Gives WebGL back to a pane an atlas rebuild left detached under a chat cover that is now closing. */
export function restoreWebglAfterChatCover(terminal: ManagedPaneInternal['terminal']): void {
  const pane = takeCoveredDetachedPane(terminal)
  if (
    pane &&
    !pane.webglAddon &&
    !isXtermInstanceDisposed(pane.terminal) &&
    pane.container.isConnected
  ) {
    reattachWebglIfNeeded(pane)
  }
}

/** Detaches every renderer; returns those to reattach. */
function detachPanesWebgl(
  panes: Iterable<ManagedPaneInternal>,
  shouldReattach?: (pane: ManagedPaneInternal) => boolean
): ManagedPaneInternal[] {
  const reattach: ManagedPaneInternal[] = []
  for (const pane of panes) {
    if (!pane.webglAddon || pane.webglDisabledAfterContextLoss) {
      continue
    }
    disposeWebgl(pane)
    // Retained hidden panes must drop their atlas too; resume reattaches them, and panes kept off screen heal on reveal or their next fit.
    if (!pane.webglAttachmentDeferred && (shouldReattach?.(pane) ?? true)) {
      reattach.push(pane)
    }
  }
  return reattach
}

/** Detaches every renderer and returns the reattach step, so no pane can keep a shared atlas alive. */
export function detachPanesWebglForRebuild(panes: Iterable<ManagedPaneInternal>): () => void {
  const reattach = detachPanesWebgl(panes)
  return () => reattach.forEach(reattachDetachedWebgl)
}

/** One context per frame: recreating every context in one task stalls the renderer for hundreds of ms. */
function reattachAcrossFrames(panes: ManagedPaneInternal[]): void {
  const [pane, ...rest] = panes
  if (!pane) {
    return
  }
  // The pane may have closed, been reattached by reveal or fit, or lost its DOM since the rebuild.
  if (!pane.webglAddon && pane.container.isConnected && !isXtermInstanceDisposed(pane.terminal)) {
    reattachDetachedWebgl(pane)
    if (pane.webglAddon) {
      paintReplacementCanvasNow(pane.terminal)
    }
  }
  if (rest.length > 0) {
    requestAnimationFrame(() => reattachAcrossFrames(rest))
  }
}

setTerminalWebglAtlasRebuilder((panes, shouldReattach) => {
  const reattach = detachPanesWebgl(panes, shouldReattach)
  // Waiting panes show xterm's DOM renderer until their frame; paint it now so a synchronized-output frame can't hold it blank.
  for (const pane of reattach.slice(1)) {
    paintReplacementCanvasNow(pane.terminal)
  }
  reattachAcrossFrames(reattach)
})
