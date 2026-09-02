import type {
  PaneManagerOptions,
  PaneStyleOptions,
  ManagedPane,
  ManagedPaneInternal,
  PaneRenderingDiagnostics,
  DropZone,
  PaneExternalDropHandler,
  PaneExternalDropResolver,
  PaneExternalDropTarget
} from './pane-manager-types'
import type { SplitPaneAroundLeafIdsOptions } from './pane-subtree-split'
import type { PaneManagerHost } from './pane-manager-host'
import {
  applyDividerStyles,
  applyPaneOpacity,
  applyRootBackground,
  disposeDividersIn
} from './pane-divider'
import { cancelActivePaneDrag, createDragReorderState, handlePaneDrop } from './pane-drag-reorder'
import { beginPaneDragFromPointerDown } from './pane-drag-pointer'
import { setLigaturesEnabled, disposePane } from './pane-lifecycle'
import { fitAllPanesInternal } from './pane-tree-ops'
import { collectPublicPanes, toPublicPane } from './pane-public-view'
import { applyTerminalGpuAcceleration } from './pane-terminal-gpu-acceleration'
import { rebuildAttachedWebgl } from './pane-webgl-reattach'
import {
  markPaneComplexScriptOutput,
  clearPaneWebglTextureAtlases,
  presentPaneViewports,
  resetPaneWebglTextureAtlases,
  resumePaneRendering,
  setPaneGpuRenderingState,
  suspendPaneRendering
} from './pane-rendering-control'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { registerLivePaneManager, unregisterLivePaneManager } from './pane-manager-registry'
import { releaseHiddenWebglRetention } from './terminal-webgl-hidden-retention'
import { schedulePaneRevealPresent, schedulePaneRevealRepaint } from './pane-reveal-repaint'
import { PaneIdentityRegistry } from './pane-identity-registry'
import { PaneReparentFrameTracker } from './pane-reparent-frame-tracker'
import {
  closePaneOnManager,
  detachPaneForExternalMoveOnManager,
  retirePanePreservingPtyOnManager,
  splitPaneAroundLeafIdsOnManager,
  splitPaneOnManager
} from './pane-manager-tree-mutations'
import {
  createInitialManagedPane,
  createManagedPaneInternal,
  publishManagedPaneCreated
} from './pane-manager-pane-creation'
import { createManagedPaneDivider, createPaneDragCallbacks } from './pane-manager-drag-wiring'
import {
  equalizeManagedPaneSizes,
  fitRevealedPanes,
  refreshAllPaneTerminals
} from './pane-manager-layout-sweeps'
import { collectPaneRenderingDiagnostics } from './pane-rendering-diagnostics'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'

export type {
  PaneManagerOptions,
  PaneStyleOptions,
  ManagedPane,
  DropZone,
  PaneExternalDropTarget,
  PaneExternalDropResolver,
  PaneExternalDropHandler
}

export class PaneManager {
  private root: HTMLElement
  private panes = new Map<number, ManagedPaneInternal>()
  private activePaneId: number | null = null
  private nextPaneId = FIRST_PANE_ID
  private options: PaneManagerOptions
  private styleOptions: PaneStyleOptions = {}
  private destroyed = false
  private renderingSuspended: boolean
  private atlasRecoveryVisible: boolean
  private identities = new PaneIdentityRegistry()
  private reparentFrames = new PaneReparentFrameTracker(() => this.destroyed)

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  private host: PaneManagerHost

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
    this.renderingSuspended = options.initialRenderingSuspended === true
    this.atlasRecoveryVisible = !this.renderingSuspended
    this.host = {
      panes: this.panes,
      root: this.root,
      identities: this.identities,
      dragState: this.dragState,
      options: this.options,
      getActivePaneId: () => this.activePaneId,
      getStyleOptions: () => this.styleOptions,
      isDestroyed: () => this.destroyed,
      isRenderingSuspended: () => this.renderingSuspended,
      allocatePaneId: () => this.nextPaneId++,
      createPaneInternal: (leafIdHint) => createManagedPaneInternal(this.host, leafIdHint),
      createDivider: (isVertical) => createManagedPaneDivider(this.host, isVertical),
      publishPaneCreated: (pane, spawnHints) =>
        publishManagedPaneCreated(this.host, pane, spawnHints),
      getDragCallbacks: () => createPaneDragCallbacks(this.host),
      setActivePane: (paneId, opts) => {
        this.setActivePane(paneId, opts)
      },
      setActivePaneId: (paneId) => {
        this.activePaneId = paneId
      },
      requestPaneReparentFrame: (callback) => {
        this.reparentFrames.request(callback)
      }
    }
    // Why: atlas recovery must reach every live manager — see
    // resetAndRefreshAllTerminalWebglAtlases for the shared-atlas rationale.
    registerLivePaneManager(this)
  }

  createInitialPane(opts?: { focus?: boolean; leafId?: string }): ManagedPane {
    return createInitialManagedPane(this.host, opts)
  }

  splitPane(
    paneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: Parameters<typeof splitPaneOnManager>[3]
  ): ManagedPane | null {
    return splitPaneOnManager(this.host, paneId, direction, opts)
  }

  splitPaneAroundLeafIds(
    sourceLeafIds: readonly string[],
    fallbackPaneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: SplitPaneAroundLeafIdsOptions
  ): ManagedPane | null {
    return splitPaneAroundLeafIdsOnManager(
      this.host,
      sourceLeafIds,
      fallbackPaneId,
      direction,
      opts
    )
  }

  closePane(paneId: number): void {
    closePaneOnManager(this.host, paneId)
  }

  detachPaneForExternalMove(paneId: number): boolean {
    return detachPaneForExternalMoveOnManager(this.host, paneId)
  }

  retirePanePreservingPty(paneId: number): boolean {
    return retirePanePreservingPtyOnManager(this.host, paneId)
  }

  getPanes(limit = Number.POSITIVE_INFINITY): ManagedPane[] {
    return collectPublicPanes(this.panes, limit)
  }

  /** Why separate from getPanes: the census runs on the crash path, where
   *  materializing every public pane view just to read `.length` is waste. */
  getPaneCount(): number {
    return this.panes.size
  }

  fitAllPanes(): void {
    fitAllPanesInternal(this.panes)
  }

  fitAllRevealedPanes(): void {
    fitRevealedPanes(this.panes)
  }

  refreshAllPanes(): void {
    refreshAllPaneTerminals(this.panes)
  }

  equalizePaneSizes(): void {
    equalizeManagedPaneSizes(this.panes, this.root, this.options.onLayoutChanged)
  }

  getActivePane(): ManagedPane | null {
    if (this.activePaneId === null) {
      return null
    }
    const pane = this.panes.get(this.activePaneId)
    return pane ? toPublicPane(pane) : null
  }

  getRenderingDiagnostics(): PaneRenderingDiagnostics[] {
    return collectPaneRenderingDiagnostics(this.panes)
  }

  hasWebglRenderer(paneId: number): boolean {
    return this.panes.get(paneId)?.webglAddon != null
  }

  getLeafId(numericPaneId: number): TerminalLeafId | null {
    return this.identities.getLeafId(numericPaneId)
  }

  getNumericIdForLeaf(leafId: string): number | null {
    return this.identities.getNumericIdForLeaf(leafId)
  }

  getLeafIdMap(): Map<number, TerminalLeafId> {
    return this.identities.getLeafIdMap()
  }

  adoptLeafId(numericPaneId: number, leafId: string): boolean {
    const pane = this.panes.get(numericPaneId)
    if (!pane) {
      return false
    }
    return this.identities.adoptPaneLeafId(numericPaneId, pane, leafId)
  }

  setActivePane(paneId: number, opts?: { focus?: boolean }): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    const changed = this.activePaneId !== paneId
    this.activePaneId = paneId
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    if (opts?.focus !== false) {
      pane.terminal.focus()
    }

    if (changed) {
      this.options.onActivePaneChange?.(toPublicPane(pane))
    }
  }

  setPaneStyleOptions(opts: PaneStyleOptions): void {
    this.styleOptions = { ...opts }
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    applyDividerStyles(this.root, this.styleOptions)
    applyRootBackground(this.root, this.styleOptions)
  }

  setPaneLigaturesEnabled(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    setLigaturesEnabled(pane, enabled)
  }

  setPaneGpuRendering(paneId: number, enabled: boolean): void {
    setPaneGpuRenderingState(this.panes, paneId, enabled)
  }

  setTerminalGpuAcceleration(mode: PaneManagerOptions['terminalGpuAcceleration']): void {
    applyTerminalGpuAcceleration(this.panes.values(), this.options, mode)
  }

  markPaneHasComplexScriptOutput(paneId: number): void {
    markPaneComplexScriptOutput(this.panes, paneId)
  }

  rebuildPaneWebgl(paneId: number): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    rebuildAttachedWebgl(pane)
  }

  resetWebglTextureAtlases(): void {
    resetPaneWebglTextureAtlases(this.panes.values())
  }

  clearWebglTextureAtlases(): void {
    clearPaneWebglTextureAtlases(this.panes.values())
  }

  presentForcedViewports(): void {
    presentPaneViewports(this.panes.values())
  }

  setAtlasRecoveryVisible(visible: boolean): void {
    this.atlasRecoveryVisible = visible
  }

  isVisibleForAtlasRecovery(): boolean {
    return this.atlasRecoveryVisible && !this.destroyed
  }

  scheduleRevealRepaint(): void {
    // Why: the settled-frame callback can fire after hide/destroy; repainting
    // hidden or disposed panes can revive WebGL contexts and latch attach
    // backoff, downgrading unrelated new panes to the DOM renderer.
    schedulePaneRevealRepaint(() => (this.isVisibleForAtlasRecovery() ? this.panes.values() : []))
  }

  scheduleRevealPresent(): void {
    // Why: ordinary reveal keeps the coherent canvas until DEC 2026 releases;
    // skip the delayed present if the surface was hidden again meanwhile.
    schedulePaneRevealPresent(() => (this.isVisibleForAtlasRecovery() ? this.panes.values() : []))
  }

  suspendRendering(): void {
    this.renderingSuspended = true
    suspendPaneRendering(this.panes.values(), {
      owner: this,
      livePanes: () => (this.destroyed ? [] : this.panes.values())
    })
  }

  resumeRendering(): void {
    this.renderingSuspended = false
    resumePaneRendering(this.panes.values(), this)
  }

  movePane(sourcePaneId: number, targetPaneId: number, zone: DropZone): void {
    handlePaneDrop(sourcePaneId, targetPaneId, zone, this.dragState, this.host.getDragCallbacks())
  }

  beginPaneDragFromPointerDown(paneId: number, handle: HTMLElement, event: PointerEvent): void {
    beginPaneDragFromPointerDown(
      handle,
      paneId,
      this.dragState,
      this.host.getDragCallbacks(),
      event
    )
  }

  destroy(): void {
    this.destroyed = true
    unregisterLivePaneManager(this)
    releaseHiddenWebglRetention(this)
    cancelActivePaneDrag(this.dragState)
    this.reparentFrames.cancelPending()
    for (const pane of this.panes.values()) {
      disposePane(pane, this.panes)
    }
    this.identities.clear()
    disposeDividersIn(this.root)
    this.root.innerHTML = ''
    this.activePaneId = null
  }
}
