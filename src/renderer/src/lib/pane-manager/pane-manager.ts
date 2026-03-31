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
import {
  createDragReorderState,
  hideDropOverlay,
  handlePaneDrop,
  updateMultiPaneState
} from './pane-drag-reorder'
import { createPaneDOM, openTerminal, attachWebgl, disposePane } from './pane-lifecycle'
import {
  findPaneChildren,
  removeDividers,
  promoteSibling,
  wrapInSplit,
  safeFit,
  refitPanesUnder
} from './pane-tree-ops'

export type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone }

export class PaneManager {
  private root: HTMLElement
  private panes: Map<number, ManagedPaneInternal> = new Map()
  private activePaneId: number | null = null
  private nextPaneId = 1
  private options: PaneManagerOptions
  private styleOptions: PaneStyleOptions = {}
  private destroyed = false

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  createInitialPane(opts?: { focus?: boolean }): ManagedPane {
    const pane = this.createPaneInternal()

    // When the pane is the sole child of root (no splits), it must
    // fill the root container so FitAddon calculates correct dimensions.
    pane.container.style.width = '100%'
    pane.container.style.height = '100%'
    pane.container.style.position = 'relative'
    pane.container.style.overflow = 'hidden'

    // Place directly into root
    this.root.appendChild(pane.container)

    openTerminal(pane)

    this.activePaneId = pane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    if (opts?.focus !== false) {
      pane.terminal.focus()
    }

    void this.options.onPaneCreated?.(this.toPublic(pane))
    return this.toPublic(pane)
  }

  splitPane(
    paneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: { ratio?: number }
  ): ManagedPane | null {
    const existing = this.panes.get(paneId)
    if (!existing) {
      return null
    }

    const newPane = this.createPaneInternal()

    const parent = existing.container.parentElement
    if (!parent) {
      return null
    }

    const isVertical = direction === 'vertical'
    const divider = this.createDividerWrapped(isVertical)

    wrapInSplit(existing.container, newPane.container, isVertical, divider, opts)

    // Open terminal for new pane
    openTerminal(newPane)

    // Set new pane active
    this.activePaneId = newPane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    this.applyDividerStylesWrapped()

    if (newPane.terminal) {
      newPane.terminal.focus()
    }

    // Refit existing pane since it now shares space
    safeFit(existing)

    updateMultiPaneState(this.getDragCallbacks())

    void this.options.onPaneCreated?.(this.toPublic(newPane))
    this.options.onLayoutChanged?.()

    return this.toPublic(newPane)
  }

  closePane(paneId: number): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }

    const paneContainer = pane.container
    const parent = paneContainer.parentElement
    if (!parent) {
      return
    }

    // Dispose terminal and addons
    disposePane(pane, this.panes)

    if (parent.classList.contains('pane-split')) {
      const siblings = findPaneChildren(parent)
      const sibling = siblings.find((c) => c !== paneContainer) ?? null

      paneContainer.remove()
      removeDividers(parent)
      promoteSibling(sibling, parent, this.root)
    } else {
      // Direct child of root (only pane) — just remove
      paneContainer.remove()
    }

    // Activate next pane if needed
    if (this.activePaneId === paneId) {
      const remaining = Array.from(this.panes.values())
      if (remaining.length > 0) {
        this.activePaneId = remaining[0].id
        remaining[0].terminal.focus()
      } else {
        this.activePaneId = null
      }
    }

    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)

    // Refit remaining panes
    for (const p of this.panes.values()) {
      safeFit(p)
    }

    updateMultiPaneState(this.getDragCallbacks())
    this.options.onPaneClosed?.(paneId)
    this.options.onLayoutChanged?.()
  }

  getPanes(): ManagedPane[] {
    return Array.from(this.panes.values()).map((p) => this.toPublic(p))
  }

  getActivePane(): ManagedPane | null {
    if (this.activePaneId === null) {
      return null
    }
    const pane = this.panes.get(this.activePaneId)
    return pane ? this.toPublic(pane) : null
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
      this.options.onActivePaneChange?.(this.toPublic(pane))
    }
  }

  setPaneStyleOptions(opts: PaneStyleOptions): void {
    this.styleOptions = { ...opts }
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    this.applyDividerStylesWrapped()
    applyRootBackground(this.root, this.styleOptions)
  }

  setPaneGpuRendering(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }

    pane.gpuRenderingEnabled = enabled

    if (!enabled) {
      if (pane.webglAddon) {
        try {
          pane.webglAddon.dispose()
        } catch {
          /* ignore */
        }
        pane.webglAddon = null
      }
      return
    }

    if (!pane.webglAddon) {
      attachWebgl(pane)
      safeFit(pane)
    }
  }

  /**
   * Suspend GPU rendering for all panes. Disposes WebGL addons to free
   * GPU contexts while keeping Terminal instances alive (scrollback, cursor,
   * screen buffer all preserved). Call when this tab/worktree becomes hidden.
   */
  suspendRendering(): void {
    for (const pane of this.panes.values()) {
      if (pane.webglAddon) {
        try {
          pane.webglAddon.dispose()
        } catch {
          /* ignore */
        }
        pane.webglAddon = null
      }
    }
  }

  /**
   * Resume GPU rendering for all panes. Recreates WebGL addons. Call when
   * this tab/worktree becomes visible again. Must be followed by a fit() pass.
   */
  resumeRendering(): void {
    for (const pane of this.panes.values()) {
      if (pane.gpuRenderingEnabled && !pane.webglAddon) {
        attachWebgl(pane)
      }
    }
  }

  /** Move a pane from its current position to a new position relative to a target pane. */
  movePane(sourcePaneId: number, targetPaneId: number, zone: DropZone): void {
    handlePaneDrop(sourcePaneId, targetPaneId, zone, this.dragState, this.getDragCallbacks())
  }

  destroy(): void {
    this.destroyed = true
    hideDropOverlay(this.dragState)
    for (const pane of this.panes.values()) {
      disposePane(pane, this.panes)
    }
    this.root.innerHTML = ''
    this.activePaneId = null
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private createPaneInternal(): ManagedPaneInternal {
    const id = this.nextPaneId++
    const pane = createPaneDOM(
      id,
      this.options,
      this.dragState,
      this.getDragCallbacks(),
      (paneId) => {
        if (!this.destroyed && this.activePaneId !== paneId) {
          this.setActivePane(paneId, { focus: true })
        }
      }
    )
    this.panes.set(id, pane)
    return pane
  }

  private createDividerWrapped(isVertical: boolean): HTMLElement {
    return createDivider(isVertical, this.styleOptions, {
      refitPanesUnder: (el) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    })
  }

  private applyDividerStylesWrapped(): void {
    applyDividerStyles(this.root, this.styleOptions)
  }

  private toPublic(pane: ManagedPaneInternal): ManagedPane {
    return {
      id: pane.id,
      terminal: pane.terminal,
      container: pane.container,
      fitAddon: pane.fitAddon,
      searchAddon: pane.searchAddon,
      serializeAddon: pane.serializeAddon
    }
  }

  /** Build the callbacks object for drag-reorder functions. */
  private getDragCallbacks() {
    return {
      getPanes: () => this.panes,
      getRoot: () => this.root,
      getStyleOptions: () => this.styleOptions,
      isDestroyed: () => this.destroyed,
      safeFit: (pane: ManagedPaneInternal) => safeFit(pane),
      applyPaneOpacity: () =>
        applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions),
      applyDividerStyles: () => this.applyDividerStylesWrapped(),
      refitPanesUnder: (el: HTMLElement) => refitPanesUnder(el, this.panes),
      onLayoutChanged: this.options.onLayoutChanged
    }
  }
}
