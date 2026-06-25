import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { DragReorderCallbacks, DragReorderState } from './pane-drag-reorder'
import { attachPaneDrag } from './pane-drag-pointer'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { buildDefaultTerminalOptions } from './pane-terminal-options'
import { shouldFocusTerminalFromPanePointerDown } from './pane-pointer-focus'
import { ENABLE_WEBGL_RENDERER } from './pane-webgl-renderer'

function getTerminalUrlOpenHint(): string {
  return navigator.userAgent.includes('Mac')
    ? 'click to open or ⇧+click for system browser'
    : 'click to open or Shift+click for system browser'
}

export function createPaneDOM(
  id: number,
  leafId: TerminalLeafId,
  options: PaneManagerOptions,
  dragState: DragReorderState,
  dragCallbacks: DragReorderCallbacks,
  onPointerDown: (id: number, options?: { focusTerminal?: boolean }) => void,
  onMouseEnter: (id: number, event: MouseEvent) => void
): ManagedPaneInternal {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)
  container.dataset.leafId = leafId

  // Why: CSS owns baseline xterm geometry so title offsets do not race safeFit().
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'xterm-container'
  container.appendChild(xtermContainer)

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

  const linkTooltip = document.createElement('div')
  linkTooltip.className = 'pane-link-tooltip'
  linkTooltip.classList.add('xterm-hover')
  linkTooltip.style.cssText =
    'display:none;position:absolute;bottom:4px;left:8px;z-index:40;' +
    'padding:5px 8px;border-radius:4px;font-size:11px;font-family:inherit;' +
    'color:#a1a1aa;background:rgba(24,24,27,0.85);border:1px solid rgba(63,63,70,0.6);' +
    'pointer-events:none;max-width:80%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'

  const dragHandle = document.createElement('div')
  dragHandle.className = 'pane-drag-handle'
  container.appendChild(dragHandle)
  const paneDragCleanup = attachPaneDrag(dragHandle, id, dragState, dragCallbacks)

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

  const panePointerDownHandler = (event: PointerEvent): void => {
    onPointerDown(id, {
      focusTerminal: shouldFocusTerminalFromPanePointerDown(event.target)
    })
  }
  const paneMouseEnterHandler = (event: MouseEvent): void => onMouseEnter(id, event)

  const pane: ManagedPaneInternal = {
    id,
    leafId,
    stablePaneId: leafId,
    terminal,
    container,
    xtermContainer,
    linkTooltip,
    terminalTuiScrollSensitivity: options.terminalTuiScrollSensitivity,
    terminalGpuAcceleration: options.terminalGpuAcceleration ?? 'auto',
    gpuRenderingEnabled: ENABLE_WEBGL_RENDERER,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    fitAddon,
    fitResizeObserver: null,
    pendingInitialFitRafId: null,
    pendingWebglRefreshRafId: null,
    pendingObservedFitRafId: null,
    searchAddon,
    serializeAddon: new SerializeAddon(),
    unicode11Addon,
    webLinksAddon,
    webglAddon: null,
    ligaturesAddon: null,
    panePointerDownHandler,
    paneMouseEnterHandler,
    paneDragCleanup,
    compositionHandler: null,
    focusClassSyncCleanup: null,
    terminalScrollIntentDisposable: null,
    pendingSplitScrollState: null,
    pendingSplitScrollRafIds: [],
    pendingSplitScrollTimerId: null,
    pendingSplitScrollBufferDisposable: null,
    debugLabel: options.debugLabel ?? null
  }

  container.addEventListener('pointerdown', panePointerDownHandler)
  container.addEventListener('mouseenter', paneMouseEnterHandler)

  return pane
}
