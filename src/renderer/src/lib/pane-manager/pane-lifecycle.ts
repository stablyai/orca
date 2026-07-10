// Upstream packaging bug: @xterm/addon-ligatures declares `"main":
// "lib/addon-ligatures.js"` but ships only the `.mjs` entry, so Vite fails to
// resolve the bare import. Fixed locally via config/patches/@xterm__addon-ligatures*.
// Tracking upstream: https://github.com/xtermjs/xterm.js/issues/5822 and
// https://github.com/xtermjs/xterm.js/pull/5828 — drop the patch once that lands.
import { LigaturesAddon } from '@xterm/addon-ligatures'

import type { ManagedPaneInternal } from './pane-manager-types'
import { safeFit } from './pane-tree-ops'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver
} from './pane-fit-resize-observer'
import { clearPendingSplitScrollRestore } from './pane-split-scroll'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'
import { attachTerminalScrollIntentTracking } from './terminal-scroll-intent'
import { attachDomRendererFocusClassSync } from './pane-dom-focus-class-sync'
import { attachWebgl, cancelPendingWebglRefresh, disposeWebgl } from './pane-webgl-renderer'
import { registerArabicShapingJoiner } from './terminal-arabic-shaping-joiner'
import { resolveCursorAgentImeAnchor } from './terminal-ime-anchor'

// ---------------------------------------------------------------------------
// Pane creation, terminal open/close, addon management
// ---------------------------------------------------------------------------

export { createPaneDOM } from './pane-dom-creation'

/** Open terminal into its container and load addons. Must be called after the container is in the DOM. */
export function openTerminal(pane: ManagedPaneInternal): void {
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

  // Open terminal into DOM
  terminal.open(xtermContainer)
  // Why: terminal.element sits under the padded xterm container. Pane-level
  // placement keeps the hover URL on the true bottom-left window corner.
  container.appendChild(linkTooltip)

  // Load addons (order matters: WebGL must be after open())
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

  // Activate Orca's Unicode 11 width shim *before* any caller-driven write. CJK / emoji /
  // ZWJ codepoints get baked into the buffer at the active unicode version on
  // write — if a restore (snapshot, scrollback, cold-restore) writes bytes
  // through xterm while the default v6 width tables are still active, wide
  // chars lay out as single cells and any subsequent re-measurement breaks
  // pairing (visible as broken `?`-style glyphs). All restore paths
  // (replayTerminalLayout → splitPane/createInitialPane → openTerminal,
  // restoreScrollbackBuffers, handleReattachResult) run after openTerminal,
  // so the activation must stay at this position.
  activateOrcaTerminalUnicodeProvider(terminal)

  // Why: without run-joining, Arabic/Hebrew output renders as disconnected
  // letters in reversed order (#5262). Registered up front so restored
  // scrollback and reattach replays shape correctly, not just live output.
  // Joining tracks the live WebGL renderer: the DOM fallback misrenders
  // joined spans (see registerArabicShapingJoiner), so it stays per-cell.
  pane.arabicShapingJoinerCleanup = registerArabicShapingJoiner(
    terminal,
    () => pane.webglAddon != null
  )

  // Why: the OS reads the focused textarea's screen rect at compositionstart to
  // decide where to display the IME candidate window. xterm positions that
  // textarea from its own cursor, which can be stale or intentionally hidden by
  // TUIs. We force-sync after xterm's own composition handlers so the OS sees
  // the corrected location before it opens the candidate window.
  //
  // Cell dimensions are derived from the public .xterm-screen element's bounds
  // (xterm sizes that element to cols*cellWidth × rows*cellHeight) rather than
  // poking `_core._renderService.dimensions` — keeps us on the public API
  // surface so upgrades don't silently regress the fix.
  if (terminal.element && terminal.textarea) {
    const screenElement = terminal.element.querySelector<HTMLElement>('.xterm-screen')
    const textarea = terminal.textarea
    const handler = (): void => {
      if (!screenElement) {
        return
      }
      const rect = screenElement.getBoundingClientRect()
      const cellWidth = rect.width / terminal.cols
      const cellHeight = rect.height / terminal.rows
      if (!(cellWidth > 0) || !(cellHeight > 0)) {
        return
      }
      const buf = terminal.buffer.active
      // Why: Cursor Agent draws its prompt UI while leaving xterm's public cursor
      // on a blank row, so the OS IME anchor needs the rendered prompt row instead.
      const cursorAgentAnchor = resolveCursorAgentImeAnchor({
        buffer: buf,
        rows: terminal.rows,
        cols: terminal.cols,
        cursorX: buf.cursorX,
        cursorY: buf.cursorY
      })
      const anchor = cursorAgentAnchor ?? {
        row: buf.cursorY,
        column: Math.min(buf.cursorX, terminal.cols - 1)
      }
      const applyAnchor = (): void => {
        textarea.style.top = `${anchor.row * cellHeight}px`
        textarea.style.left = `${anchor.column * cellWidth}px`
      }
      applyAnchor()
      if (cursorAgentAnchor) {
        window.setTimeout(() => {
          if (textarea.isConnected) {
            applyAnchor()
          }
        }, 0)
      }
    }
    terminal.element.addEventListener('compositionstart', handler)
    terminal.element.addEventListener('compositionupdate', handler)
    // Store so disposePane() can remove it and avoid a memory leak.
    pane.compositionHandler = handler
  }

  pane.focusClassSyncCleanup = attachDomRendererFocusClassSync(terminal.element)

  if (pane.gpuRenderingEnabled) {
    attachWebgl(pane)
  }

  attachPaneFitResizeObserver(pane)

  // Initial fit (deferred to ensure layout has settled)
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
    } catch {
      /* ignore */
    }
    pane.ligaturesAddon = null
  }
}

export function attachLigatures(pane: ManagedPaneInternal): void {
  if (pane.ligaturesAddon) {
    return
  }
  try {
    const ligaturesAddon = new LigaturesAddon()
    pane.terminal.loadAddon(ligaturesAddon)
    pane.ligaturesAddon = ligaturesAddon
    // Why: ligatures can be enabled after rows already rendered, especially
    // from Settings. Force existing glyph runs to be recomputed immediately.
    pane.terminal.refresh(0, pane.terminal.rows - 1)
    // Why: the WebGL renderer builds its glyph texture atlas at activation
    // time, so `font-feature-settings` applied after WebGL loaded won't
    // reach the GPU-rendered cells until the atlas is rebuilt. The upstream
    // docs call this out explicitly — reactivating WebGL after ligatures
    // forces a fresh atlas that includes the ligated glyphs.
    if (pane.webglAddon) {
      disposeWebgl(pane)
      attachWebgl(pane)
    }
  } catch (err) {
    console.warn('[terminal] ligatures addon failed to attach for pane', pane.id, err)
    pane.ligaturesAddon = null
  }
}

/** Enable or disable ligatures in-place, reusing the running terminal so the
 *  setting can be toggled without dropping scrollback or the PTY binding. */
export function setLigaturesEnabled(pane: ManagedPaneInternal, enabled: boolean): void {
  if (enabled) {
    attachLigatures(pane)
  } else if (pane.ligaturesAddon) {
    disposeLigatures(pane)
    // Why: ligatures lived inside the WebGL atlas, so after disposing the
    // addon the atlas still holds the ligated glyphs. Rebuild it so text
    // renders as the non-ligated fallback immediately.
    if (pane.webglAddon) {
      disposeWebgl(pane)
      attachWebgl(pane)
    }
  }
}

export function disposePane(
  pane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): void {
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
  pane.terminalScrollIntentDisposable?.dispose()
  pane.terminalScrollIntentDisposable = null
  // Deregister the RTL shaping joiner: terminal.dispose() below does not.
  try {
    pane.arabicShapingJoinerCleanup?.()
  } catch {
    /* ignore */
  }
  pane.arabicShapingJoinerCleanup = null
  if (pane.compositionHandler) {
    pane.terminal.element?.removeEventListener('compositionstart', pane.compositionHandler)
    pane.terminal.element?.removeEventListener('compositionupdate', pane.compositionHandler)
    pane.compositionHandler = null
  }
  try {
    clearPendingSplitScrollRestore(pane)
  } catch {
    /* ignore */
  }
  try {
    pane.ligaturesAddon?.dispose()
  } catch {
    /* ignore */
  }
  disposeWebgl(pane)
  try {
    pane.searchAddon.dispose()
  } catch {
    /* ignore */
  }
  try {
    pane.serializeAddon.dispose()
  } catch {
    /* ignore */
  }
  try {
    pane.unicode11Addon.dispose()
  } catch {
    /* ignore */
  }
  try {
    pane.webLinksAddon.dispose()
  } catch {
    /* ignore */
  }
  try {
    pane.fitAddon.dispose()
  } catch {
    /* ignore */
  }
  try {
    pane.terminal.dispose()
  } catch {
    /* ignore */
  }
  panes.delete(pane.id)
}
