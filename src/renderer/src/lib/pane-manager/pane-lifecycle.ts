import { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'

import type { PaneManagerOptions, ManagedPaneInternal } from './pane-manager-types'
import type { DragReorderState } from './pane-drag-reorder'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { attachPaneDrag } from './pane-drag-reorder'
import { safeFit, captureScrollState, restoreScrollState } from './pane-tree-ops'
import {
  attachPaneFitResizeObserver,
  detachPaneFitResizeObserver
} from './pane-fit-resize-observer'

// ---------------------------------------------------------------------------
// Pane creation, terminal open/close, addon management
// ---------------------------------------------------------------------------

const ENABLE_WEBGL_RENDERER = true

export function buildDefaultTerminalOptions(): ITerminalOptions {
  return {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 14,
    // Cross-platform fallback chain — ensures the terminal can always find a
    // usable monospace font regardless of OS, even if user settings haven't
    // loaded yet. macOS-only fonts are harmlessly skipped on other platforms.
    // Must stay in sync with FALLBACK_FONTS in layout-serialization.ts; the
    // trailing Nerd Fonts let Powerline/PUA glyphs render even at first paint
    // before the user's configured terminalFontFamily is applied.
    fontFamily:
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace',
    fontWeight: '300',
    fontWeightBold: '500',
    scrollback: 10000,
    allowTransparency: false,
    // Why: on macOS, non-US layouts rely on Option to compose real characters
    // like @ (German Option+L) and € (German Option+E). Enabling xterm's
    // Meta mode here makes Option behave like Esc+key instead, which steals
    // those composed characters before they reach the shell.
    // Readline shortcuts (Option+B/F/D) are compensated in terminal-shortcut-policy.ts.
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true
  }
}

function getTerminalUrlOpenHint(): string {
  return navigator.userAgent.includes('Mac')
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
}

export function createPaneDOM(
  id: number,
  options: PaneManagerOptions,
  dragState: DragReorderState,
  dragCallbacks: DragReorderCallbacks,
  onPointerDown: (id: number) => void,
  onMouseEnter: (id: number, event: MouseEvent) => void
): ManagedPaneInternal {
  // Create .pane container
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)

  // Create .xterm-container — baseline layout (position, width, height, margin)
  // is CSS-driven (see main.css .xterm-container) so that the data-has-title
  // attribute override can shift the terminal down without racing safeFit().
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'xterm-container'
  container.appendChild(xtermContainer)

  // Build terminal options
  const userOpts = options.terminalOptions?.(id) ?? {}
  const terminalOpts: ITerminalOptions = {
    ...buildDefaultTerminalOptions(),
    ...userOpts
  }

  const terminal = new Terminal(terminalOpts)
  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  const unicode11Addon = new Unicode11Addon()
  const openLinkHint = getTerminalUrlOpenHint()

  // URL tooltip element — Ghostty-style bottom-left hint on hover
  const linkTooltip = document.createElement('div')
  linkTooltip.className = 'pane-link-tooltip'
  linkTooltip.classList.add('xterm-hover')
  linkTooltip.style.cssText =
    'display:none;position:absolute;bottom:4px;left:8px;z-index:40;' +
    'padding:5px 8px;border-radius:4px;font-size:11px;font-family:inherit;' +
    'color:#a1a1aa;background:rgba(24,24,27,0.85);border:1px solid rgba(63,63,70,0.6);' +
    'pointer-events:none;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

  // Ghostty-style drag handle — appears at top of pane on hover when 2+ panes
  const dragHandle = document.createElement('div')
  dragHandle.className = 'pane-drag-handle'
  container.appendChild(dragHandle)
  attachPaneDrag(dragHandle, id, dragState, dragCallbacks)

  const webLinksAddon = new WebLinksAddon(
    options.onLinkClick ? (event, uri) => options.onLinkClick!(event, uri) : undefined,
    {
      hover: (_event, uri) => {
        if (uri) {
          linkTooltip.textContent = `${uri} (${openLinkHint})`
          linkTooltip.style.display = ''
        }
      },
      leave: () => {
        linkTooltip.style.display = 'none'
      }
    }
  )

  const serializeAddon = new SerializeAddon()

  const pane: ManagedPaneInternal = {
    id,
    terminal,
    container,
    xtermContainer,
    linkTooltip,
    gpuRenderingEnabled: ENABLE_WEBGL_RENDERER,
    fitAddon,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    searchAddon,
    serializeAddon,
    unicode11Addon,
    webLinksAddon,
    webglAddon: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    pendingDragScrollState: null
  }

  // Focus handler: clicking a pane makes it active and explicitly focuses
  // the terminal. We must call focus: true here because after DOM reparenting
  // (e.g. splitPane moves the original pane into a flex container), xterm.js's
  // native click-to-focus on its internal textarea may not fire reliably.
  container.addEventListener('pointerdown', () => {
    onPointerDown(id)
  })

  // Focus-follows-mouse handler: when the setting is enabled, hovering a
  // pane makes it active. All gating (feature flag, drag-in-progress,
  // window focus, etc.) lives in the PaneManager callback — this layer
  // just forwards the event.
  container.addEventListener('mouseenter', (event) => {
    onMouseEnter(id, event)
  })

  return pane
}

/** Open terminal into its container and load addons. Must be called after the container is in the DOM. */
export function openTerminal(pane: ManagedPaneInternal): void {
  const {
    terminal,
    xtermContainer,
    linkTooltip,
    fitAddon,
    searchAddon,
    serializeAddon,
    unicode11Addon,
    webLinksAddon
  } = pane

  // Open terminal into DOM
  terminal.open(xtermContainer)
  const linkTooltipContainer = terminal.element ?? xtermContainer
  linkTooltipContainer.appendChild(linkTooltip)

  // Load addons (order matters: WebGL must be after open())
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(unicode11Addon)
  terminal.loadAddon(webLinksAddon)

  // Activate unicode 11
  terminal.unicode.activeVersion = '11'

  // Why: the OS reads the focused textarea's screen rect at compositionstart to
  // decide where to display the IME candidate window. xterm.js only repositions
  // the textarea on compositionupdate (via updateCompositionElements), not on
  // compositionstart, so the window can appear at a stale cursor position. We
  // force-sync the textarea position in a capture-phase listener so the OS sees
  // the correct location before it opens the candidate window.
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
      const x = Math.min(buf.cursorX, terminal.cols - 1)
      textarea.style.top = `${buf.cursorY * cellHeight}px`
      textarea.style.left = `${x * cellWidth}px`
    }
    terminal.element.addEventListener('compositionstart', handler, true)
    // Store so disposePane() can remove it and avoid a memory leak.
    pane.compositionHandler = handler
  }

  if (pane.gpuRenderingEnabled) {
    attachWebgl(pane)
  }

  attachPaneFitResizeObserver(pane)

  // Initial fit (deferred to ensure layout has settled)
  requestAnimationFrame(() => {
    safeFit(pane)
  })
}

export function disposeWebgl(pane: ManagedPaneInternal): void {
  if (pane.webglAddon) {
    try {
      pane.webglAddon.dispose()
    } catch {
      /* ignore */
    }
    pane.webglAddon = null
  }
}

export function attachWebgl(pane: ManagedPaneInternal): void {
  if (!ENABLE_WEBGL_RENDERER || !pane.gpuRenderingEnabled) {
    pane.webglAddon = null
    return
  }
  try {
    const webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      console.warn(
        '[terminal] WebGL context lost for pane',
        pane.id,
        '— falling back to DOM renderer'
      )
      webglAddon.dispose()
      pane.webglAddon = null
      // Why: when the WebGL context is lost (GPU memory pressure, Chromium
      // context limit, driver hiccup), the GPU-rendered canvas goes blank
      // instantly — this is standard browser behaviour. After disposing the
      // addon, xterm.js falls back to the DOM renderer, but it may not
      // redraw the viewport unprompted.  Without an explicit
      // refresh + refit, the scrollback area appears as blank space at the
      // top of the terminal while only the most recent output is visible at
      // the bottom. Deferring to the next frame gives the DOM renderer time
      // to initialise before we ask it to repaint.
      //
      // Why content-match instead of wasAtBottom: context loss often fires
      // during splitPane when a new WebGL canvas is created and Chromium
      // reclaims the old one. The fit() here triggers a reflow that changes
      // line numbering; the simple wasAtBottom check can't track partially-
      // scrolled positions and would undo scroll restoration from splitPane.
      requestAnimationFrame(() => {
        try {
          if (pane.pendingSplitScrollState) {
            pane.fitAddon.fit()
          } else if (pane.pendingDragScrollState) {
            pane.fitAddon.fit()
            restoreScrollState(pane.terminal, pane.pendingDragScrollState)
          } else {
            const scrollState = captureScrollState(pane.terminal)
            pane.fitAddon.fit()
            restoreScrollState(pane.terminal, scrollState)
          }
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        } catch {
          /* ignore — pane may have been disposed in the meantime */
        }
      })
    })
    pane.terminal.loadAddon(webglAddon)
    pane.webglAddon = webglAddon
  } catch (err) {
    // WebGL not available — default DOM renderer is fine, but log it for debugging
    console.warn('[terminal] WebGL unavailable for pane', pane.id, '— using DOM renderer:', err)
    pane.webglAddon = null
  }
}

export function disposePane(
  pane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): void {
  detachPaneFitResizeObserver(pane)
  if (pane.compositionHandler) {
    pane.terminal.element?.removeEventListener('compositionstart', pane.compositionHandler, true)
    pane.compositionHandler = null
  }
  try {
    pane.webglAddon?.dispose()
  } catch {
    /* ignore */
  }
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
