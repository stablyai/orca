import type { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { LigaturesAddon } from '@xterm/addon-ligatures'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane) => void | Promise<void>
  onPaneClosed?: (paneId: number) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
  initialRenderingSuspended?: boolean
}

export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
  // Why this behavior flag lives on "style" options: this type is already
  // the single runtime-settings bag the PaneManager exposes. Splitting into
  // separate style vs behavior types is a refactor worth its own change
  // when a second behavior flag lands. See docs/focus-follows-mouse-design.md.
  focusFollowsMouse?: boolean
  paddingX?: number
  paddingY?: number
}

export type ManagedPane = {
  id: number
  terminal: Terminal
  container: HTMLElement // the .pane element
  linkTooltip: HTMLElement
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ScrollState = {
  wasAtBottom: boolean
  firstVisibleLineContent: string
  viewportY: number
  totalLines: number
}

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  gpuRenderingEnabled: boolean
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  webglAddon: WebglAddon | null
  // Why nullable: ligatures are opt-in per font and toggleable at runtime,
  // so the addon instance only exists while the feature is active. A null
  // value means "currently disabled".
  ligaturesAddon: LigaturesAddon | null
  fitResizeObserver: ResizeObserver | null
  pendingObservedFitRafId: number | null
  serializeAddon: SerializeAddon
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
  // Stored so disposePane() can remove it and avoid a memory leak.
  compositionHandler: (() => void) | null
  // Why: during splitPane, multiple async operations (rAFs, ResizeObserver
  // debounce, WebGL context loss) may independently attempt scroll
  // restoration. This field acts as a lock: when set, safeFit and other
  // intermediate fit paths skip their own scroll restoration, deferring to
  // the splitPane's final authoritative restore.
  pendingSplitScrollState: ScrollState | null
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
