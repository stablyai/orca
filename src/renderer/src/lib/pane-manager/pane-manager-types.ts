import type { IDisposable, IMarker, Terminal } from '@xterm/xterm'
import type { ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { LigaturesAddon } from '@xterm/addon-ligatures'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { GlobalSettings } from '../../../../shared/types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalWebglAutoDecision } from './terminal-webgl-auto-policy'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Hints forwarded from splitPane() into onPaneCreated for a single split.
 *  Carries one-shot PTY spawn/adoption data for the new pane.
 *  Kept as a separate parameter (rather than extending ManagedPane) so the
 *  hint is scoped to pane creation and does not live on the pane afterwards. */
export type PaneSpawnHints = {
  cwd?: string
  ptyId?: string
}

export type ClosedPaneInfo = {
  paneId: number
  leafId: TerminalLeafId
  reason?: 'close' | 'detach'
}

export type PaneExternalDropTarget = {
  id: string
  rect: DOMRect
  overlayKind?: 'area' | 'insertion'
}

export type PaneExternalDropResolver = (args: {
  sourcePaneId: number
  clientX: number
  clientY: number
}) => PaneExternalDropTarget | null

export type PaneExternalDropHandler = (
  sourcePaneId: number,
  target: PaneExternalDropTarget
) => boolean

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane, spawnHints?: PaneSpawnHints) => void | Promise<void>
  onPaneClosed?: (paneId: number, closedPane?: ClosedPaneInfo) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  /** Why: Electron webviews can steal pointer streams from renderer-owned
   *  pane drags unless callers temporarily put them in pointer passthrough. */
  onPaneDragActiveChange?: (active: boolean) => void
  resolveExternalPaneDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  terminalTuiScrollSensitivity?: () => number | undefined
  onLinkClick?: (event: MouseEvent | undefined, url: string) => void
  formatLinkTooltip?: (
    url: string,
    openLinkHint: string
  ) => string | null | undefined | Promise<string | null | undefined>
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
  /** Durable terminal layout leaf UUID. Use this for paneKey/ORCA_PANE_KEY and
   *  persisted leaf-keyed state; `id` is only the live renderer handle. */
  leafId: TerminalLeafId
  /** Compatibility alias while callers migrate from the older stablePaneId name. */
  stablePaneId: TerminalLeafId
  terminal: Terminal
  container: HTMLElement // the .pane element
  linkTooltip: HTMLElement
  fitAddon: FitAddon
  searchAddon: SearchAddon
  serializeAddon: SerializeAddon
}

export type PaneRenderingDiagnostics = {
  paneId: number
  terminalGpuAcceleration: GlobalSettings['terminalGpuAcceleration']
  gpuRenderingEnabled: boolean
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  hasComplexScriptOutput: boolean
  terminalWebglAutoDecision: TerminalWebglAutoDecision
  hasWebgl: boolean
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ScrollState = {
  bufferType: 'normal' | 'alternate'
  wasAtBottom: boolean
  viewportY: number
  baseY: number
  firstVisibleLineMarker?: IMarker
  firstVisibleLogicalLineMarker?: IMarker
  firstVisibleLogicalCellOffset?: number
}

export type ManagedPaneInternal = {
  xtermContainer: HTMLElement
  linkTooltip: HTMLElement
  terminalTuiScrollSensitivity?: () => number | undefined
  terminalGpuAcceleration: GlobalSettings['terminalGpuAcceleration']
  gpuRenderingEnabled: boolean
  webglAttachmentDeferred: boolean
  webglDisabledAfterContextLoss: boolean
  // Why: expose complex-output diagnostics without changing renderer choice;
  // auto renderer fallback is reserved for platform or WebGL failures.
  hasComplexScriptOutput: boolean
  webglAddon: WebglAddon | null
  // Why nullable: ligatures are opt-in per font and toggleable at runtime,
  // so the addon instance only exists while the feature is active. A null
  // value means "currently disabled".
  ligaturesAddon: LigaturesAddon | null
  fitResizeObserver: ResizeObserver | null
  // Stored so disposePane() can cancel the first post-open fit if a pane closes before paint.
  pendingInitialFitRafId?: number | null
  // Stored so disposePane() can cancel the post-WebGL-teardown refresh frame.
  pendingWebglRefreshRafId?: number | null
  pendingObservedFitRafId: number | null
  serializeAddon: SerializeAddon
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
  // Stored so disposePane() can remove pane-local DOM listeners explicitly.
  panePointerDownHandler?: ((event: PointerEvent) => void) | null
  paneMouseEnterHandler?: ((event: MouseEvent) => void) | null
  paneDragCleanup?: (() => void) | null
  // Stored so disposePane() can remove it and avoid a memory leak.
  compositionHandler: (() => void) | null
  // Stored so disposePane() can remove DOM-renderer focus synchronization.
  focusClassSyncCleanup?: (() => void) | null
  // Stored so disposePane() can remove user-scroll intent listeners.
  terminalScrollIntentDisposable?: IDisposable | null
  // Stored so disposePane() can detach the streamed-output hover-cache reset
  // that keeps freshly printed links linkifiable without a scroll.
  linkifierHoverResetDisposable?: IDisposable | null
  // Stored so disposePane() can deregister the joiner; terminal.dispose()
  // does not remove registered character joiners.
  arabicShapingJoinerCleanup?: (() => void) | null
  // Why: splitPane reparents DOM; its delayed restore owns scroll until the
  // browser settles, so intermediate fits must not compete with it.
  pendingSplitScrollState: ScrollState | null
  // Stored so repeated split restores and disposePane() can cancel deferred
  // restore handles instead of leaving stale pane closures alive.
  pendingSplitScrollRafIds?: number[]
  pendingSplitScrollTimerId?: ReturnType<typeof setTimeout> | null
  // Stored so repeated split restores and disposePane() can remove the
  // deferred alt-screen buffer listener instead of stacking callbacks.
  pendingSplitScrollBufferDisposable?: IDisposable | null
  debugLabel: string | null
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
