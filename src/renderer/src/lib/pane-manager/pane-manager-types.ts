import type { IDisposable, IMarker, Terminal, ITerminalOptions } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { ImageAddon } from '@xterm/addon-image'
import type { LigaturesAddon } from '@xterm/addon-ligatures'
import type { SearchAddon } from '@xterm/addon-search'
import type { Unicode11Addon } from '@xterm/addon-unicode11'
import type { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SerializeAddon } from '@xterm/addon-serialize'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import type { TerminalWebglAutoDecision } from './terminal-webgl-auto-policy'

export type { TerminalScrollIntentTarget } from './terminal-scroll-intent'

/** One-shot spawn/adoption hints belong to creation, separate from persistent ManagedPane state. */
export type PaneSpawnHints = {
  cwd?: string
  cwdPromise?: Promise<string>
  ptyId?: string
  /** Where the pane's leaf sits; main reads it only for a leaf it does not know yet. */
  placement?: TerminalPanePlacement
}

export type PaneSplitOptions = Omit<PaneSpawnHints, 'placement'> & {
  ratio?: number
  leafId?: string
}

export type ClosedPaneInfo = {
  paneId: number
  leafId: TerminalLeafId
  reason?: 'close' | 'detach' | 'retire'
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

export type PaneDropTaker = (
  drop: { sourcePaneId: number; targetPaneId: number; zone: DropZone },
  move: () => void
) => boolean

export type PaneManagerOptions = {
  onPaneCreated?: (pane: ManagedPane, spawnHints?: PaneSpawnHints) => void | Promise<void>
  onPaneClosed?: (paneId: number, closedPane?: ClosedPaneInfo) => void
  onActivePaneChange?: (pane: ManagedPane) => void
  onLayoutChanged?: () => void
  // Temporarily bypass Electron webview pointers during pane drags or webviews steal the stream.
  onPaneDragActiveChange?: (active: boolean) => void
  resolveExternalPaneDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
  /** A user's divider drag or reset ended; runs after `onLayoutChanged`. */
  onDividerRatiosCommitted?: () => void
  /** Takes an in-tab pane drop instead of moving it now: true means `move` runs later or never. */
  takePaneDrop?: PaneDropTaker
  terminalOptions?: (paneId: number) => Partial<ITerminalOptions>
  terminalLigaturesEnabled?: () => boolean
  terminalInlineImagesEnabled?: () => boolean
  terminalTuiScrollSensitivity?: () => number | undefined
  onLinkClick?: (paneId: number, event: MouseEvent | undefined, url: string) => void
  // Resolve hints per hover so settings stay current; require wiring at compile time, scoped to the hovered pane’s host routes.
  // Why: required so dropping the wiring is a compile error — an optional hint with a
  // default would silently serve stale copy that no test can distinguish.
  // Why: paneId-scoped because the hovered pane's host decides where its links can go.
  linkOpenHint: (paneId: number) => string
  formatLinkTooltip?: (
    paneId: number,
    url: string,
    openLinkHint: string
  ) => string | null | undefined | Promise<string | null | undefined>
  initialRenderingSuspended?: boolean
  retainHiddenWebgl?: boolean
  terminalGpuAcceleration?: GlobalSettings['terminalGpuAcceleration']
  // Correlate internal fit warnings with their tab/worktree.
  debugLabel?: string
}

export type PaneStyleOptions = {
  splitBackground?: string
  paneBackground?: string
  inactivePaneOpacity?: number
  activePaneOpacity?: number
  opacityTransitionMs?: number
  dividerThicknessPx?: number
  // Use the existing runtime-settings bag for this behavior flag; split behavior/style types when another flag warrants it (focus-follows-mouse-design.md).
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
  container: HTMLElement
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
  webglContextLossesInWindow?: number
  webglAttachFailedSinceRecovery: boolean
  hasComplexScriptOutput: boolean
  terminalWebglAutoDecision: TerminalWebglAutoDecision
  hasWebgl: boolean
}

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
  // Shared history bounds context-loss retries across resume and settled reveal.
  webglContextLossTimestamps?: number[]
  // Hidden retained renderers rebuild at the resume boundary, never behind the hidden surface.
  webglRebuildDeferred?: boolean
  // Latch attach failure per pane so one failure cannot strand all panes on DOM; absent means never failed.
  webglAttachFailedSinceRecovery?: boolean
  // Complex-output diagnostics must not select renderers; automatic fallback is for platform/WebGL failures.
  hasComplexScriptOutput: boolean
  webglAddon: WebglAddon | null
  // Ligatures are optional and toggleable; null means disabled.
  ligaturesAddon: LigaturesAddon | null
  // Images are optional and lazy-loaded; null means disabled or not yet resolved.
  imageAddon: ImageAddon | null
  // Enabled but waiting for the lazy addon; onLoaded drains these panes.
  imageAttachmentDeferred?: boolean
  fitResizeObserver: ResizeObserver | null
  // Last successful fit’s host pixels distinguish real hidden-time resizes from cell-metric wobble.
  lastFitClientSize?: { width: number; height: number }
  // Stored so disposePane() can cancel the first post-open fit if a pane closes before paint.
  pendingInitialFitRafId?: number | null
  pendingWebglRefreshRafId?: number | null
  pendingObservedFitRafId: number | null
  serializeAddon: SerializeAddon
  unicode11Addon: Unicode11Addon
  webLinksAddon: WebLinksAddon
  panePointerDownHandler?: ((event: PointerEvent) => void) | null
  paneMouseEnterHandler?: ((event: MouseEvent) => void) | null
  paneDragCleanup?: (() => void) | null
  compositionHandler: (() => void) | null
  focusClassSyncCleanup?: (() => void) | null
  domBlockFillCleanup?: (() => void) | null
  terminalScrollIntentDisposable?: IDisposable | null
  mouseEncodingTrackerDisposable?: IDisposable | null
  // Dispose the output-driven hover-cache reset with the pane.
  linkifierHoverResetDisposable?: IDisposable | null
  // Stored because mouseleave does not bubble from xterm's screen.
  linkifierMouseLeaveResetDisposable?: IDisposable | null
  // Window blur can strand an active link without another mouse event.
  linkifierWindowBlurResetDisposable?: IDisposable | null
  // Deregister explicitly: terminal.dispose() leaves character joiners registered.
  arabicShapingJoinerCleanup?: (() => void) | null
  // Split reparent’s delayed scroll restore owns the settle window; intermediate fits must not compete.
  pendingSplitScrollState: ScrollState | null
  // Cancel obsolete split restores on repetition/disposal rather than retaining stale pane closures.
  pendingSplitScrollRafIds?: number[]
  pendingSplitScrollTimerId?: ReturnType<typeof setTimeout> | null
  // Replace/remove the deferred alt-screen listener instead of stacking split-restore callbacks.
  pendingSplitScrollBufferDisposable?: IDisposable | null
  debugLabel: string | null
} & ManagedPane

export type DropZone = 'top' | 'bottom' | 'left' | 'right'
