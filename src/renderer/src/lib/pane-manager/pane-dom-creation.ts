import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import type { ILink, ITerminalOptions } from '@xterm/xterm'
import { createWrappedTerminalHttpLinkProvider } from '../../components/terminal-pane/wrapped-terminal-http-link-provider'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { DragReorderCallbacks, DragReorderState } from './pane-drag-reorder'
import { attachPaneDrag } from './pane-drag-pointer'
import type { ManagedPaneInternal, PaneManagerOptions } from './pane-manager-types'
import { buildDefaultTerminalOptions } from './pane-terminal-options'
import { shouldFocusTerminalFromPanePointerDown } from './pane-pointer-focus'
import { ENABLE_WEBGL_RENDERER } from './pane-webgl-renderer'
import { installGuardedLinkProviderRegistration } from './terminal-link-provider-guard'
import { installWindowsCtrlAltChordRepair } from './terminal-windows-ctrl-alt-chord-classification'
import { installTerminalMouseEncodingTracker } from './terminal-mouse-encoding-tracker'
import { StableCellFitAddon } from './terminal-stable-cell-fit-addon'

function defaultLinkTooltipText(uri: string, openLinkHint: string): string {
  return `${uri} (${openLinkHint})`
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
  // Why: a synchronous throw inside any link provider's provideLinks (notably
  // xterm web-links' LinkComputer raising RangeError on a pathological wrapped
  // line) escapes to window.onerror and gets the renderer killed. Guard every
  // provider registered after this point — addon-internal and Orca's own.
  installGuardedLinkProviderRegistration(terminal)
  installWindowsCtrlAltChordRepair(terminal)
  // Why here: the tracker must see every byte, including the first snapshot replay.
  const mouseEncodingTrackerDisposable = installTerminalMouseEncodingTracker(terminal)
  const fitAddon = new StableCellFitAddon()
  const searchAddon = new SearchAddon()
  const unicode11Addon = new Unicode11Addon()
  // Why: async tooltip formatting can resolve after hover changes, so stale
  // results must not overwrite the tooltip for the currently hovered link.
  let linkTooltipHoverToken = 0

  const linkTooltip = document.createElement('div')
  // Why: styles live in terminal.css (.pane-link-tooltip) so the hover URL stays
  // flush to the pane corner without inline padding/offset drift.
  linkTooltip.className = 'pane-link-tooltip xterm-hover'
  linkTooltip.style.display = 'none'

  const dragHandle = document.createElement('div')
  dragHandle.className = 'pane-drag-handle'
  container.appendChild(dragHandle)
  const paneDragCleanup = attachPaneDrag(dragHandle, id, dragState, dragCallbacks)

  const linkHandlers = {
    activate: (event, uri) => options.onLinkClick?.(id, event, uri),
    hover: (_event, uri) => {
      if (uri) {
        linkTooltipHoverToken += 1
        const hoverToken = linkTooltipHoverToken
        const openLinkHint = options.linkOpenHint(id)
        linkTooltip.textContent = defaultLinkTooltipText(uri, openLinkHint)
        linkTooltip.style.display = ''
        const formatted = options.formatLinkTooltip?.(id, uri, openLinkHint)
        if (formatted && typeof formatted === 'object' && 'then' in formatted) {
          void formatted.then(
            (nextText) => {
              if (hoverToken === linkTooltipHoverToken && nextText) {
                linkTooltip.textContent = nextText
              }
            },
            () => undefined
          )
        } else if (formatted) {
          linkTooltip.textContent = formatted
        }
      }
    },
    leave: () => {
      linkTooltipHoverToken += 1
      linkTooltip.style.display = 'none'
    }
  } satisfies Pick<ILink, 'activate' | 'hover' | 'leave'>
  if (options.onLinkClick) {
    terminal.registerLinkProvider(createWrappedTerminalHttpLinkProvider(terminal, linkHandlers))
  }
  const webLinksAddon = new WebLinksAddon(
    options.onLinkClick ? linkHandlers.activate : undefined,
    linkHandlers
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
    webglRebuildDeferred: false,
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
    imageAddon: null,
    imageAttachmentDeferred: false,
    panePointerDownHandler,
    paneMouseEnterHandler,
    paneDragCleanup,
    compositionHandler: null,
    focusClassSyncCleanup: null,
    domBlockFillCleanup: null,
    terminalScrollIntentDisposable: null,
    mouseEncodingTrackerDisposable,
    linkifierMouseLeaveResetDisposable: null,
    arabicShapingJoinerCleanup: null,
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
