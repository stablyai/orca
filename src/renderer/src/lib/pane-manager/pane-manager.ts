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
import { shouldFollowMouseFocus } from './focus-follows-mouse'
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

    // Why: wrapInSplit reparents the existing container via replaceChild +
    // appendChild, which can cause the browser to reset scrollTop on xterm's
    // viewport element to 0 during the next layout. Capture the scroll-at-
    // bottom state now, before the DOM reparenting corrupts it.
    const buf = existing.terminal.buffer.active
    const wasAtBottom = buf.viewportY >= buf.baseY

    wrapInSplit(existing.container, newPane.container, isVertical, divider, opts)

    // Why: immediately restore the scroll position after DOM reparenting so
    // that xterm's internal viewportY stays correct when the browser fires
    // asynchronous scroll events during its layout phase.
    if (wasAtBottom) {
      existing.terminal.scrollToBottom()
    }

    // Open terminal for new pane
    openTerminal(newPane)

    // Set new pane active
    this.activePaneId = newPane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    this.applyDividerStylesWrapped()

    if (newPane.terminal) {
      newPane.terminal.focus()
    }

    updateMultiPaneState(this.getDragCallbacks())

    void this.options.onPaneCreated?.(this.toPublic(newPane))
    this.options.onLayoutChanged?.()

    // Why: belt-and-suspenders for the scroll position — the deferred
    // fitPanes (from onLayoutChanged → queueResizeAll) reflows the buffer
    // for the new column count, which changes baseY. If the browser's
    // rendering pipeline fired a scroll event that reset viewportY between
    // our synchronous scrollToBottom above and the rAF, safeFit's
    // wasAtBottom check would read false and skip scrollToBottom. This
    // final rAF runs after fitPanes (FIFO ordering) and unconditionally
    // restores the scroll-to-bottom state.
    if (wasAtBottom) {
      const existingPaneId = existing.id
      requestAnimationFrame(() => {
        // Why: replayTerminalLayout can create a PaneManager, split panes,
        // then tear the whole manager down (e.g. when the owning worktree
        // deactivates) before this rAF fires. Touching xterm's renderer
        // after disposePane throws "Cannot read properties of undefined
        // (reading 'dimensions')". Resolve the pane from the live map so
        // we no-op instead of crashing.
        if (this.destroyed) {
          return
        }
        const live = this.panes.get(existingPaneId)
        if (!live) {
          return
        }
        live.terminal.scrollToBottom()
      })
    }

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
        if (!this.destroyed) {
          // Why: split-pane layout/focus callbacks can leave the manager's
          // activePaneId temporarily in sync while the browser's real focused
          // xterm textarea is still on a different pane. Clicking a pane must
          // always re-focus its terminal, even if the manager already thinks
          // that pane is active; otherwise input can keep going to the wrong
          // split after vertical/horizontal splits.
          this.setActivePane(paneId, { focus: true })
        }
      },
      (paneId, event) => {
        this.handlePaneMouseEnter(paneId, event)
      }
    )
    this.panes.set(id, pane)
    return pane
  }

  /**
   * Focus-follows-mouse entry point. Collects gate inputs from the manager
   * and delegates to the pure gate helper.
   *
   * Invariant for future contributors: modal overlays (context menus, close
   * dialogs, command palette) must be rendered as portals/siblings OUTSIDE
   * the pane container. If a future overlay is ever rendered inside a .pane
   * element, mouseenter will still fire on the pane underneath and this
   * handler will incorrectly switch focus. Keep overlays out of the pane.
   */
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

  private applyDividerStylesWrapped(): void {
    applyDividerStyles(this.root, this.styleOptions)
  }

  private toPublic(pane: ManagedPaneInternal): ManagedPane {
    return {
      id: pane.id,
      terminal: pane.terminal,
      container: pane.container,
      linkTooltip: pane.linkTooltip,
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
