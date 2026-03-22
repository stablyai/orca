import { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'

import type { PaneManagerOptions, ManagedPaneInternal } from './pane-manager-types'
import type { DragReorderState } from './pane-drag-reorder'
import type { DragReorderCallbacks } from './pane-drag-reorder'
import { attachPaneDrag } from './pane-drag-reorder'
import { safeFit } from './pane-tree-ops'

// ---------------------------------------------------------------------------
// Pane creation, terminal open/close, addon management
// ---------------------------------------------------------------------------

const TERMINAL_PADDING = 4

export function createPaneDOM(
  id: number,
  options: PaneManagerOptions,
  dragState: DragReorderState,
  dragCallbacks: DragReorderCallbacks,
  onPointerDown: (id: number) => void
): ManagedPaneInternal {
  // Create .pane container
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)

  // Create .xterm-container with small inset padding
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'xterm-container'
  xtermContainer.style.width = `calc(100% - ${TERMINAL_PADDING}px)`
  xtermContainer.style.height = `calc(100% - ${TERMINAL_PADDING}px)`
  xtermContainer.style.marginTop = `${TERMINAL_PADDING}px`
  xtermContainer.style.marginLeft = `${TERMINAL_PADDING}px`
  container.appendChild(xtermContainer)

  // Build terminal options
  const userOpts = options.terminalOptions?.(id) ?? {}
  const terminalOpts: ITerminalOptions = {
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 14,
    fontFamily: '"SF Mono", Menlo, monospace',
    fontWeight: '300',
    fontWeightBold: '500',
    scrollback: 10000,
    allowTransparency: false,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    ...userOpts
  }

  const terminal = new Terminal(terminalOpts)
  const fitAddon = new FitAddon()
  const searchAddon = new SearchAddon()
  const unicode11Addon = new Unicode11Addon()

  // URL tooltip element — Ghostty-style bottom-left hint on hover
  const linkTooltip = document.createElement('div')
  linkTooltip.className = 'pane-link-tooltip'
  linkTooltip.style.cssText =
    'display:none;position:absolute;bottom:4px;left:8px;z-index:40;' +
    'padding:2px 8px;border-radius:4px;font-size:11px;font-family:inherit;' +
    'color:#a1a1aa;background:rgba(24,24,27,0.85);border:1px solid rgba(63,63,70,0.6);' +
    'pointer-events:none;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
  container.appendChild(linkTooltip)

  // Ghostty-style drag handle — appears at top of pane on hover when 2+ panes
  const dragHandle = document.createElement('div')
  dragHandle.className = 'pane-drag-handle'
  container.appendChild(dragHandle)
  attachPaneDrag(dragHandle, id, dragState, dragCallbacks)

  const webLinksAddon = new WebLinksAddon(
    options.onLinkClick ? (_event, uri) => options.onLinkClick!(uri) : undefined,
    {
      hover: (event, uri) => {
        if (event.type === 'mouseover' && uri) {
          linkTooltip.textContent = uri
          linkTooltip.style.display = ''
        } else {
          linkTooltip.style.display = 'none'
        }
      }
    }
  )

  const pane: ManagedPaneInternal = {
    id,
    terminal,
    container,
    xtermContainer,
    fitAddon,
    searchAddon,
    unicode11Addon,
    webLinksAddon,
    webglAddon: null
  }

  // Focus handler: clicking a pane makes it active and explicitly focuses
  // the terminal. We must call focus: true here because after DOM reparenting
  // (e.g. splitPane moves the original pane into a flex container), xterm.js's
  // native click-to-focus on its internal textarea may not fire reliably.
  container.addEventListener('pointerdown', () => {
    onPointerDown(id)
  })

  return pane
}

/** Open terminal into its container and load addons. Must be called after the container is in the DOM. */
export function openTerminal(pane: ManagedPaneInternal): void {
  const { terminal, xtermContainer, fitAddon, searchAddon, unicode11Addon, webLinksAddon } = pane

  // Open terminal into DOM
  terminal.open(xtermContainer)

  // Load addons (order matters: WebGL must be after open())
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(unicode11Addon)
  terminal.loadAddon(webLinksAddon)

  // Activate unicode 11
  terminal.unicode.activeVersion = '11'

  // Attach GPU renderer
  attachWebgl(pane)

  // Initial fit (deferred to ensure layout has settled)
  requestAnimationFrame(() => {
    safeFit(pane)
  })
}

export function attachWebgl(pane: ManagedPaneInternal): void {
  try {
    const webglAddon = new WebglAddon()
    webglAddon.onContextLoss(() => {
      webglAddon.dispose()
      pane.webglAddon = null
    })
    pane.terminal.loadAddon(webglAddon)
    pane.webglAddon = webglAddon
  } catch {
    // WebGL not available — default DOM renderer is fine
    pane.webglAddon = null
  }
}

export function disposePane(
  pane: ManagedPaneInternal,
  panes: Map<number, ManagedPaneInternal>
): void {
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
