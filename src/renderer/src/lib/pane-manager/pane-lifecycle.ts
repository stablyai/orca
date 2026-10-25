import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver
} from './pane-fit-resize-observer'
import { clearPendingSplitScrollRestore } from './pane-split-scroll'
import { cancelDeferredScrollRestore } from './pane-scroll'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent-dom-tracking'
import {
  installTerminalLinkifierHoverResetOnMouseLeave,
  installTerminalLinkifierHoverResetOnWindowBlur
} from './terminal-linkifier-hover-reset-on-mouseleave'
import { installTerminalLinkifierHoverResetOnWrite } from './terminal-linkifier-hover-reset-on-write'
import { attachDomRendererFocusClassSync } from './pane-dom-focus-class-sync'
import { attachDomBlockFill } from './terminal-dom-block-fill'
import { attachWebgl, cancelPendingWebglRefresh, disposeWebgl } from './pane-webgl-renderer'
import { rebuildAttachedWebgl } from './pane-webgl-reattach'
import { configureLazyArabicShapingJoiner } from './terminal-arabic-shaping-joiner'
import { TerminalLigaturesAddon } from './terminal-ligatures-addon'
import { attachInlineImages, detachInlineImages } from './pane-inline-images'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'
import { cancelPendingTerminalViewportPresents } from './pane-viewport-present'

export { createPaneDOM } from './pane-dom-creation'

/** Open after DOM insertion; named options prevent silently swapped adjacent booleans. */
export function openTerminal(
  pane: ManagedPaneInternal,
  // Named rather than positional: two adjacent optional booleans swap silently.
  { ligatures = false, inlineImages = false }: { ligatures?: boolean; inlineImages?: boolean } = {}
): void {
  const {
    terminal,
    container,
    xtermContainer,
    linkTooltip,
    terminalTuiScrollSensitivity,
    fitAddon,
    searchAddon,
    serializeAddon,
    unicode11Addon,
    webLinksAddon
  } = pane

  terminal.open(xtermContainer)
  // Pane-level tooltips reach the true corner; terminal.element sits inside xterm padding.
  container.appendChild(linkTooltip)

  // WebGL must load after open().
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(unicode11Addon)
  terminal.loadAddon(webLinksAddon)
  attachTerminalMouseWheelMultiplier(terminal, {
    getTuiMouseWheelMultiplier: terminalTuiScrollSensitivity
  })
  pane.terminalScrollIntentDisposable = attachTerminalScrollIntentTracking(
    terminal,
    xtermContainer,
    pane.leafId
  )
  // Invalidate hover cache on output so streamed links under a stationary pointer relink on its next move.
  pane.linkifierHoverResetDisposable = installTerminalLinkifierHoverResetOnWrite(terminal)
  pane.linkifierMouseLeaveResetDisposable = installTerminalLinkifierHoverResetOnMouseLeave(
    terminal,
    linkTooltip
  )
  pane.linkifierWindowBlurResetDisposable = installTerminalLinkifierHoverResetOnWindowBlur(
    terminal,
    linkTooltip
  )

  // Activate Unicode v11 before every restore/write path: xterm bakes widths into cells, and default v6 mismeasures CJK/emoji/ZWJ into broken glyphs.
  activateOrcaTerminalUnicodeProvider(terminal)

  // Any joiner scans the whole grid each repaint; register lazily before the first live/replayed RTL parse.
  pane.arabicShapingJoinerCleanup = configureLazyArabicShapingJoiner(
    terminal,
    () => pane.webglAddon != null
  )

  pane.compositionHandler = installTerminalImeCandidateAnchor(terminal)

  pane.focusClassSyncCleanup = attachDomRendererFocusClassSync(terminal.element)
  pane.domBlockFillCleanup = attachDomBlockFill(terminal)

  // Configure the first atlas with ligatures instead of immediately rebuilding it.
  if (ligatures) {
    attachLigatures(pane)
  }
  // Deferred attachment restores Orca's DA1 handler after the addon registers its own.
  if (inlineImages) {
    attachInlineImages(pane)
  }
  if (pane.gpuRenderingEnabled) {
    attachWebgl(pane)
  }

  attachPaneFitResizeObserver(pane)

  if (pane.pendingInitialFitRafId != null) {
    cancelAnimationFrame(pane.pendingInitialFitRafId)
  }
  pane.pendingInitialFitRafId = requestAnimationFrame(() => {
    pane.pendingInitialFitRafId = null
    safeFit(pane)
  })
}

export function disposeLigatures(pane: ManagedPaneInternal): void {
  if (pane.ligaturesAddon) {
    try {
      pane.ligaturesAddon.dispose()
    } catch {}
    pane.ligaturesAddon = null
  }
}

export function attachLigatures(pane: ManagedPaneInternal): void {
  if (pane.ligaturesAddon) {
    return
  }
  try {
    const ligaturesAddon = new TerminalLigaturesAddon()
    pane.terminal.loadAddon(ligaturesAddon)
    pane.ligaturesAddon = ligaturesAddon
    // Recompute existing glyph runs when ligatures are enabled after rendering, including Settings toggles.
    if (!pane.webglAttachmentDeferred) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
    // WebGL samples font features at atlas creation; rebuild after enabling ligatures so GPU cells reflect them.
    rebuildAttachedWebgl(pane)
  } catch (err) {
    console.warn('[terminal] ligatures addon failed to attach for pane', pane.id, err)
    pane.ligaturesAddon = null
  }
}

export function setLigaturesEnabled(pane: ManagedPaneInternal, enabled: boolean): void {
  if (enabled) {
    attachLigatures(pane)
  } else if (pane.ligaturesAddon) {
    disposeLigatures(pane)
    // Disposed ligatures remain baked into the WebGL atlas; rebuild for immediate non-ligated rendering.
    rebuildAttachedWebgl(pane)
  }
}

export function disposePane(
  pane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): void {
  cancelPendingTerminalViewportPresents(pane.terminal)
  if (pane.pendingInitialFitRafId != null) {
    cancelAnimationFrame(pane.pendingInitialFitRafId)
    pane.pendingInitialFitRafId = null
  }
  cancelPendingWebglRefresh(pane)
  detachPaneFitResizeObserver(pane)
  if (pane.panePointerDownHandler) {
    pane.container.removeEventListener('pointerdown', pane.panePointerDownHandler)
    pane.panePointerDownHandler = null
  }
  if (pane.paneMouseEnterHandler) {
    pane.container.removeEventListener('mouseenter', pane.paneMouseEnterHandler)
    pane.paneMouseEnterHandler = null
  }
  pane.paneDragCleanup?.()
  pane.paneDragCleanup = null
  pane.focusClassSyncCleanup?.()
  pane.focusClassSyncCleanup = null
  pane.domBlockFillCleanup?.()
  pane.domBlockFillCleanup = null
  pane.terminalScrollIntentDisposable?.dispose()
  pane.terminalScrollIntentDisposable = null
  pane.mouseEncodingTrackerDisposable?.dispose()
  pane.mouseEncodingTrackerDisposable = null
  pane.linkifierHoverResetDisposable?.dispose()
  pane.linkifierHoverResetDisposable = null
  pane.linkifierMouseLeaveResetDisposable?.dispose()
  pane.linkifierMouseLeaveResetDisposable = null
  pane.linkifierWindowBlurResetDisposable?.dispose()
  pane.linkifierWindowBlurResetDisposable = null
  // Deregister the RTL shaping joiner: terminal.dispose() below does not.
  try {
    pane.arabicShapingJoinerCleanup?.()
  } catch {}
  pane.arabicShapingJoinerCleanup = null
  if (pane.compositionHandler) {
    pane.terminal.element?.removeEventListener('compositionstart', pane.compositionHandler)
    pane.terminal.element?.removeEventListener('compositionupdate', pane.compositionHandler)
    pane.compositionHandler = null
  }
  try {
    clearPendingSplitScrollRestore(pane)
  } catch {}
  try {
    // Fit retries own markers/frames independently of split restoration; release both before terminal disposal.
    cancelDeferredScrollRestore(pane.terminal)
  } catch {}
  try {
    pane.ligaturesAddon?.dispose()
  } catch {}
  // Detach pending and live image addons before terminal teardown, including their canvases/parser handlers.
  detachInlineImages(pane)
  disposeWebgl(pane)
  try {
    pane.searchAddon.dispose()
  } catch {}
  try {
    pane.serializeAddon.dispose()
  } catch {}
  try {
    pane.unicode11Addon.dispose()
  } catch {}
  try {
    pane.webLinksAddon.dispose()
  } catch {}
  try {
    pane.fitAddon.dispose()
  } catch {}
  try {
    // Drop renderer selection state before a recovery remount replaces the surface.
    pane.terminal.clearSelection()
  } catch {}
  try {
    pane.terminal.dispose()
  } catch {}
  panes.delete(pane.id)
}
