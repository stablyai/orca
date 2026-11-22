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

// A pane mid synchronized-output frame keeps its old context until the frame closes; after this many frames it rechecks on a slower timer instead.
const SYNC_WAIT_FRAMES = 120
const SYNC_WAIT_SLOW_MS = 250

// One queue for every rebuild, so overlapping batches still recreate at most one context per frame; weak, so a pane closed while queued is never kept alive.
const rebuildQueue: WeakRef<ManagedPaneInternal>[] = []
const queuedPanes = new WeakSet<ManagedPaneInternal>()
let queueVerdict: (pane: ManagedPaneInternal) => DeferredReattachVerdict = () => 'skip'
let queueRunning = false

function nextQueuedPane(): ManagedPaneInternal | undefined {
  while (rebuildQueue.length > 0) {
    const pane = rebuildQueue[0].deref()
    // The pane may have closed, lost its renderer or its DOM since it was queued.
    if (
      pane?.webglAddon &&
      !pane.webglDisabledAfterContextLoss &&
      pane.container.isConnected &&
      !isXtermInstanceDisposed(pane.terminal)
    ) {
      return pane
    }
    if (pane) {
      queuedPanes.delete(pane)
    }
    rebuildQueue.shift()
  }
  return undefined
}

/** One pane per frame, so no frame pays for more than one context; user input holds the rest, which keep rendering on their old context meanwhile. */
function runRebuildQueue(waitedFrames = 0): void {
  const pane = nextQueuedPane()
  if (!pane) {
    queueRunning = false
    return
  }
  const hold = terminalWebglAtlasInteractionHoldMs()
  if (hold > 0) {
    setTimeout(() => requestAnimationFrame(() => runRebuildQueue(waitedFrames)), hold)
    return
  }
  // Decided on its own frame: a tab revealed or a chat cover closed since the rebuild started gets a new context, not a dropped one.
  const verdict = queueVerdict(pane)
  if (verdict === 'wait') {
    // Never painted mid-frame: past the frame budget it keeps checking, more slowly, on its old context.
    if (waitedFrames < SYNC_WAIT_FRAMES) {
      requestAnimationFrame(() => runRebuildQueue(waitedFrames + 1))
    } else {
      setTimeout(() => runRebuildQueue(waitedFrames), SYNC_WAIT_SLOW_MS)
    }
    return
  }
  rebuildQueue.shift()
  queuedPanes.delete(pane)
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
  requestAnimationFrame(() => runRebuildQueue())
}

setTerminalWebglAtlasRebuilder((panes, shouldReattach, verdictOnItsFrame) => {
  queueVerdict = verdictOnItsFrame
  // Shown panes first; the atlas module already emptied each atlas in place, so every recreated context joins a small one.
  const steps = panes
    .filter((pane) => pane.webglAddon && !pane.webglDisabledAfterContextLoss)
    .sort((a, b) => Number(shouldReattach(b)) - Number(shouldReattach(a)))
  for (const pane of steps) {
    if (!queuedPanes.has(pane)) {
      queuedPanes.add(pane)
      rebuildQueue.push(new WeakRef(pane))
    }
  }
  if (!queueRunning) {
    queueRunning = true
    runRebuildQueue()
  }
})
