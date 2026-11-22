import type { ManagedPaneInternal } from '../pane-manager-types'
import { attachWebgl, clearTerminalWebglAttachBackoff, disposeWebgl } from './pane-webgl-renderer'
import { canRetryPaneWebglAfterContextLoss } from './pane-webgl-context-loss-policy'
import {
  setTerminalWebglAtlasRebuilder,
  takeCoveredDetachedPane,
  type DeferredReattachVerdict
} from './terminal-webgl-atlas-memory-rebuild'
import {
  isTerminalWebglAtlasRebuildParked,
  terminalWebglAtlasInteractionHoldMs,
  whenTerminalWebglAtlasRebuildUnparked
} from './terminal-webgl-atlas-rebuild-interaction'
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

// A pane mid synchronized-output frame keeps its old context and goes to the back of the queue; when only waiting panes remain the queue rechecks this often, and drops a pane still waiting after the cap (it keeps its old context).
const SYNC_WAIT_RECHECK_MS = 250
const SYNC_WAIT_CAP_MS = 10_000

// One queue for every rebuild, so overlapping batches still recreate at most one context per frame; weak, so a pane closed while queued is never kept alive.
const rebuildQueue: WeakRef<ManagedPaneInternal>[] = []
const queuedPanes = new WeakSet<ManagedPaneInternal>()
let queueVerdict: (pane: ManagedPaneInternal) => DeferredReattachVerdict = () => 'skip'
let queueRunning = false
const waitingSince = new WeakMap<ManagedPaneInternal, number>()

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
function runRebuildQueue(): void {
  if (isTerminalWebglAtlasRebuildParked()) {
    // Hidden or unfocused mid-rebuild: the rest keep their old contexts until the window is back.
    whenTerminalWebglAtlasRebuildUnparked(() => requestAnimationFrame(runRebuildQueue))
    return
  }
  const hold = terminalWebglAtlasInteractionHoldMs()
  if (hold > 0) {
    setTimeout(() => requestAnimationFrame(runRebuildQueue), hold)
    return
  }
  // Waiting panes rotate to the back, so one stuck frame never blocks the panes behind it.
  let recreated = false
  for (let looked = rebuildQueue.length; looked > 0; looked--) {
    const candidate = nextQueuedPane()
    if (!candidate) {
      break
    }
    // Decided on its own frame: a tab revealed or a chat cover closed since the rebuild started gets a new context, not a dropped one.
    const verdict = queueVerdict(candidate)
    if (verdict !== 'wait') {
      recreated = true
      rebuildQueue.shift()
      queuedPanes.delete(candidate)
      waitingSince.delete(candidate)
      if (verdict === 'skip') {
        // Off screen or chat-covered: drop its context now; reveal, fit, resume or the cover closing gives it a new one.
        disposeWebgl(candidate)
      } else {
        // Dispose and attach in one task, so the pane never shows the DOM renderer.
        rebuildAttachedWebgl(candidate)
        if (candidate.webglAddon) {
          paintReplacementCanvasNow(candidate.terminal)
        }
      }
      break
    }
    const entry = rebuildQueue.shift()
    const since = waitingSince.get(candidate) ?? performance.now()
    if (performance.now() - since >= SYNC_WAIT_CAP_MS) {
      // A frame that never closes: leave this pane on its old context rather than paint it mid-frame or hold the queue.
      queuedPanes.delete(candidate)
      waitingSince.delete(candidate)
    } else if (entry) {
      waitingSince.set(candidate, since)
      rebuildQueue.push(entry)
    }
  }
  if (rebuildQueue.length === 0) {
    queueRunning = false
    return
  }
  // One context per frame; when every remaining pane is mid-frame, look again a little later.
  if (recreated) {
    requestAnimationFrame(runRebuildQueue)
  } else {
    setTimeout(() => requestAnimationFrame(runRebuildQueue), SYNC_WAIT_RECHECK_MS)
  }
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
    // Starts on a frame of its own, so the first step never shares one with the second.
    requestAnimationFrame(runRebuildQueue)
  }
})
