import type { Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { LigaturesAddon } from '@xterm/addon-ligatures'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { GlobalSettings } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Hints forwarded from splitPane() into onPaneCreated for a single split.
 *  Currently only carries the resolved cwd for the new pane's PTY spawn.
 *  Kept as a separate parameter (rather than extending ManagedPane) so the
 *  hint is scoped to pane creation and does not live on the pane afterwards. */
export type PaneSpawnHints = {
  cwd?: string
}

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane, spawnHints?: PaneSpawnHints) => void | Promise<void>
  onPaneClosed?: (paneId: number) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
  initialRenderingSuspended?: boolean
  terminalGpuAcceleration?: GlobalSettings['terminalGpuAcceleration']
  // Why: diagnostic label for log correlation. safeFit and other internal
  // helpers log warnings that are hard to correlate without knowing which
  // tab/worktree the PaneManager belongs to.
  debugLabel?: string
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
  bufferType: 'normal' | 'alternate'
  wasAtBottom: boolean
  firstVisibleLineContent: string
  viewportY: number
  totalLines: number
}

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  terminalGpuAcceleration: GlobalSettings['terminalGpuAcceleration']
  gpuRenderingEnabled: boolean
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  // Why: complex-script shaping/RTL rendering is visibly wrong in xterm WebGL;
  // keep auto-mode panes on DOM once their output proves they need browser text shaping.
  hasComplexScriptOutput: boolean
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
  debugLabel: string | null
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
