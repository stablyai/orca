import type {
  PaneManagerOptions,
  PaneStyleOptions,
  ManagedPane,
  ManagedPaneInternal,
  DropZone
} from './pane-manager-types'
import {
  createDivider,
  applyDividerStyles,
  applyPaneOpacity,
  applyRootBackground
} from './pane-divider'
import { createDragReorderState, hideDropOverlay, handlePaneDrop } from './pane-drag-reorder'
import { createPaneDOM, openTerminal, setLigaturesEnabled, disposePane } from './pane-lifecycle'
import { shouldFollowMouseFocus } from './focus-follows-mouse'
import { equalizePaneSplitSizes, safeFit, fitAllPanesInternal, refitPanesUnder } from './pane-tree-ops'
import { toPublicPane } from './pane-public-view'
import { applyTerminalGpuAcceleration } from './pane-terminal-gpu-acceleration'
import {
  markPaneComplexScriptOutput,
  resumePaneRendering,
  setPaneGpuRenderingState,
  suspendPaneRendering
} from './pane-rendering-control'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { PaneIdentityRegistry } from './pane-identity-registry'
import { closeManagedPane, splitManagedPane } from './pane-split-close'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'

export type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone }

export class PaneManager {
  private root: HTMLElement
  private panes: Map<number, ManagedPaneInternal> = new Map()
  private activePaneId: number | null = null
  private nextPaneId = FIRST_PANE_ID
  private options: PaneManagerOptions
  private styleOptions: PaneStyleOptions = {}
  private destroyed = false
  private renderingSuspended: boolean
  private identities = new PaneIdentityRegistry()

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
    this.renderingSuspended = options.initialRenderingSuspended === true
  }

  createInitialPane(opts?: { focus?: boolean; leafId?: string }): ManagedPane {
    const pane = this.createPaneInternal(opts?.leafId)
    Object.assign(pane.container.style, {
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden'
    })
    this.root.appendChild(pane.container)
    openTerminal(pane)
    this.activePaneId = pane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    if (opts?.focus !== false) {
      pane.terminal.focus()
    }

    this.publishPaneCreated(pane)
    return toPublicPane(pane)
  }

  splitPane(
    paneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: { ratio?: number; cwd?: string; leafId?: string }
  ): ManagedPane | null {
    return splitManagedPane({
      paneId,
      direction,
      opts,
      panes: this.panes,
      root: this.root,
      styleOptions: this.styleOptions,
      managerOptions: this.options,
      createPaneInternal: (leafIdHint) => this.createPaneInternal(leafIdHint),
      createDivider: (isVertical) => this.createDividerWrapped(isVertical),
      publishPaneCreated: (pane, spawnHints) => this.publishPaneCreated(pane, spawnHints),
      getDragCallbacks: () => this.getDragCallbacks(),
      setActivePaneId: (id) => {
        this.activePaneId = id
      },
      isDestroyed: () => this.destroyed
    })
  }

  closePane(paneId: number): void {
    closeManagedPane({
      paneId,
      activePaneId: this.activePaneId,
      panes: this.panes,
      root: this.root,
      styleOptions: this.styleOptions,
      managerOptions: this.options,
      getDragCallbacks: () => this.getDragCallbacks(),
      releasePaneIdentity: (numericPaneId) => this.identities.release(numericPaneId),
      setActivePaneId: (id) => {
        this.activePaneId = id
      }
    })
  }

  getPanes(): ManagedPane[] {
    return Array.from(this.panes.values()).map(toPublicPane)
  }

  fitAllPanes(): void {
    fitAllPanesInternal(this.panes)
  }

  equalizePaneSizes(): void {
    if (this.panes.size < 2) {
      return
    }

    const changed = equalizePaneSplitSizes(
      this.root.firstElementChild instanceof HTMLElement ? this.root.firstElementChild : null
    )
    if (!changed) {
      return
    }

    this.options.onLayoutChanged?.()
  }

  getActivePane(): ManagedPane | null {
    if (this.activePaneId === null) {
      return null
    }
    const pane = this.panes.get(this.activePaneId)
    return pane ? toPublicPane(pane) : null
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

  suspendRendering(): void {
    this.renderingSuspended = true
    suspendPaneRendering(this.panes.values())
  }

  resumeRendering(): void {
    this.renderingSuspended = false
    resumePaneRendering(this.panes.values())
  }

  movePane(sourcePaneId: number, targetPaneId: number, zone: DropZone): void {
    handlePaneDrop(sourcePaneId, targetPaneId, zone, this.dragState, this.getDragCallbacks())
  }

  destroy(): void {
    this.destroyed = true
    hideDropOverlay(this.dragState)
    for (const pane of this.panes.values()) {
      disposePane(pane, this.panes)
    }
    this.identities.clear()
    this.root.innerHTML = ''
    this.activePaneId = null
  }

  private createPaneInternal(leafIdHint?: string): ManagedPaneInternal {
    const id = this.nextPaneId++
    const leafId = this.identities.claimLeafId(leafIdHint)
    const pane = createPaneDOM(
      id,
      leafId,
      this.options,
      this.dragState,
      this.getDragCallbacks(),
      // Why: always re-focus even if already active — after splits the
      // browser's real textarea focus can lag the manager's activePaneId.
      (paneId) => {
        if (!this.destroyed) {
          this.setActivePane(paneId, { focus: true })
        }
      },
      (paneId, event) => {
        this.handlePaneMouseEnter(paneId, event)
      }
    )
    pane.webglAttachmentDeferred = this.renderingSuspended
    this.panes.set(id, pane)
    this.identities.register(id, leafId)
    return pane
  }

  private publishPaneCreated(
    pane: ManagedPaneInternal,
    spawnHints?: Parameters<NonNullable<PaneManagerOptions['onPaneCreated']>>[1]
  ): void {
    // Why: onPaneCreated wires PTY/status identity synchronously. After this
    // point, replacing the leaf id would fork ORCA_PANE_KEY from layout state.
    this.identities.markPublished(pane.id)
    void this.options.onPaneCreated?.(toPublicPane(pane), spawnHints)
  }

  private handlePaneMouseEnter(paneId: number, event: MouseEvent): void {
    if (
      shouldFollowMouseFocus({
        featureEnabled: this.styleOptions.focusFollowsMouse ?? false,
        activePaneId: this.activePaneId,
        hoveredPaneId: paneId,
        mouseButtons: event.buttons,
        windowHasFocus: document.hasFocus(),
        managerDestroyed: this.destroyed
      })
    ) {
      this.setActivePane(paneId, { focus: true })
    }
  }

  private createDividerWrapped(isVertical: boolean): HTMLElement {
    return createDivider(isVertical, this.styleOptions, {
      refitPanesUnder: (el) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    })
  }

  private getDragCallbacks() {
    return {
      getPanes: () => this.panes,
      getRoot: () => this.root,
      getStyleOptions: () => this.styleOptions,
      isDestroyed: () => this.destroyed,
      safeFit,
      applyPaneOpacity: () =>
        applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions),
      applyDividerStyles: () => applyDividerStyles(this.root, this.styleOptions),
      refitPanesUnder: (el: HTMLElement) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    }
  }
}
