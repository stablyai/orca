import type { ManagedPaneInternal } from '../pane-manager-types'
import { attachWebgl, clearTerminalWebglAttachBackoff, disposeWebgl } from './pane-webgl-renderer'
import { canRetryPaneWebglAfterContextLoss } from './pane-webgl-context-loss-policy'
import {
  setTerminalWebglAtlasRebuilder,
  takeCoveredDetachedPane,
  terminalWebglAtlasInteractionHoldMs,
  type DeferredReattachVerdict
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

// xterm's own watchdog ends a synchronized frame within a second; past this, recreate anyway rather than keep the old context.
const MAX_SYNC_WAIT_FRAMES = 120

type RebuildStep = { pane: ManagedPaneInternal; recreate: boolean }

/** One pane per frame, so no frame pays for more than one context; user input holds the rest, which keep rendering on their old context meanwhile. */
function rebuildAcrossFrames(
  steps: RebuildStep[],
  verdictOf: (pane: ManagedPaneInternal) => DeferredReattachVerdict,
  waitedFrames = 0
): void {
  const [step, ...rest] = steps
  if (!step) {
    return
  }
  const hold = terminalWebglAtlasInteractionHoldMs()
  if (hold > 0) {
    setTimeout(
      () => requestAnimationFrame(() => rebuildAcrossFrames(steps, verdictOf, waitedFrames)),
      hold
    )
    return
  }
  const { pane } = step
  // The pane may have closed, lost its renderer or its DOM since the rebuild started.
  if (
    pane.webglAddon &&
    !pane.webglDisabledAfterContextLoss &&
    pane.container.isConnected &&
    !isXtermInstanceDisposed(pane.terminal)
  ) {
    const verdict = step.recreate ? verdictOf(pane) : 'skip'
    if (verdict === 'wait' && waitedFrames < MAX_SYNC_WAIT_FRAMES) {
      requestAnimationFrame(() => rebuildAcrossFrames(steps, verdictOf, waitedFrames + 1))
      return
    }
    if (verdict === 'skip') {
      // Off screen or chat-covered: drop its context now; reveal, fit, resume or the cover closing gives it a new one.
      disposeWebgl(pane)
    } else {
      // Dispose and attach in one task, so the pane never shows the DOM renderer.
      rebuildAttachedWebgl(pane)
      if (pane.webglAddon) {
        paintReplacementCanvasNow(pane.terminal)
      }
    }
  }
  if (rest.length > 0) {
    requestAnimationFrame(() => rebuildAcrossFrames(rest, verdictOf))
  }
}

setTerminalWebglAtlasRebuilder((panes, shouldReattach, verdictOnItsFrame) => {
  const steps = panes
    .filter((pane) => pane.webglAddon && !pane.webglDisabledAfterContextLoss)
    .map((pane) => ({ pane, recreate: shouldReattach(pane) }))
    .sort((a, b) => Number(b.recreate) - Number(a.recreate))
  // Clearing the shared atlas first means every recreated context joins a small atlas, and destroying each old context frees what it retained; on a quiet screen the waiting panes keep their last frame.
  steps[0]?.pane.webglAddon?.clearTextureAtlas()
  rebuildAcrossFrames(steps, verdictOnItsFrame)
})
