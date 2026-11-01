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
  tryRetainHiddenPanesWebgl,
  type HiddenWebglRetentionOwner
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
  retention?: {
    owner: HiddenWebglRetentionOwner
    livePanes: () => Iterable<ManagedPaneInternal>
  }
): void {
  const suspended = Array.from(panes)
  // Blur both suspension branches: opacity:0 startup probes can retain focus even though display:none/inert normally blur and disposal stops blink.
  for (const pane of suspended) {
    pane.webglAttachmentDeferred = true
    pane.terminal.blur()
    // Suspend blink before the retention return: live WebGL uses document focus, so an unfocused terminal could otherwise redraw for five minutes.
    suspendTerminalCursorBlink(pane.terminal)
  }
  // Retain recent hidden WebGL for immediate switch-back; evicted/over-cap owners dispose.
  if (retention && tryRetainHiddenPanesWebgl(retention.owner, retention.livePanes)) {
    return
  }
  for (const pane of suspended) {
    disposeWebgl(pane)
  }
}

export function resumePaneRendering(
  panes: Iterable<ManagedPaneInternal>,
  retentionOwner?: HiddenWebglRetentionOwner
): void {
  if (retentionOwner) {
    releaseHiddenWebglRetention(retentionOwner)
  }
  for (const pane of panes) {
    clearTerminalWebglAttachBackoff(pane)
    // Restore blink before constructing WebGL so its first frame samples the right option.
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
