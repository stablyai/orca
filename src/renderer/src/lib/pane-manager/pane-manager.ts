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
import {
  createPaneDOM,
  openTerminal,
  attachWebgl,
  disposeWebgl,
  setLigaturesEnabled,
  disposePane
} from './pane-lifecycle'
import { shouldFollowMouseFocus } from './focus-follows-mouse'
import {
  findPaneChildren,
  removeDividers,
  promoteSibling,
  wrapInSplit,
  safeFit,
  fitAllPanesInternal,
  captureScrollState,
  refitPanesUnder
} from './pane-tree-ops'
import { scheduleSplitScrollRestore } from './pane-split-scroll'
import { toPublicPane } from './pane-public-view'

export type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone }

export class PaneManager {
  private root: HTMLElement
  private panes: Map<number, ManagedPaneInternal> = new Map()
  private activePaneId: number | null = null
  private nextPaneId = 1
  private options: PaneManagerOptions
  private styleOptions: PaneStyleOptions = {}
  private destroyed = false
  private renderingSuspended: boolean

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
    this.renderingSuspended = options.initialRenderingSuspended === true
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

    void this.options.onPaneCreated?.(toPublicPane(pane))
    return toPublicPane(pane)
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

    // Why: wrapInSplit reparents the existing container, which causes the
    // browser to asynchronously reset scrollTop to 0 during layout. Capture
    // the scroll state before reparenting so we can restore it after all
    // layout and reflow have settled.
    const scrollState = captureScrollState(existing.terminal)

    // Why: multiple async operations fire after the split (rAFs from
    // queueResizeAll, WebGL context loss, ResizeObserver 150ms debounce).
    // Each would independently try to restore scroll, potentially to wrong
    // positions due to intermediate buffer states. The lock makes safeFit
    // and fitAllPanesInternal skip their own scroll restoration, leaving
    // the authoritative restore to the timeout below.
    existing.pendingSplitScrollState = scrollState

    wrapInSplit(existing.container, newPane.container, isVertical, divider, opts)

    openTerminal(newPane)
    this.activePaneId = newPane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    this.applyDividerStylesWrapped()
    newPane.terminal?.focus()
    updateMultiPaneState(this.getDragCallbacks())
    void this.options.onPaneCreated?.(toPublicPane(newPane))
    this.options.onLayoutChanged?.()

    scheduleSplitScrollRestore(
      (id) => this.panes.get(id),
      existing.id,
      scrollState,
      () => this.destroyed
    )

    return toPublicPane(newPane)
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
    disposePane(pane, this.panes)
    if (parent.classList.contains('pane-split')) {
      const siblings = findPaneChildren(parent)
      const sibling = siblings.find((c) => c !== paneContainer) ?? null
      paneContainer.remove()
      removeDividers(parent)
      promoteSibling(sibling, parent, this.root)
    } else {
      paneContainer.remove()
    }
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
    for (const p of this.panes.values()) {
      safeFit(p)
    }
    updateMultiPaneState(this.getDragCallbacks())
    this.options.onPaneClosed?.(paneId)
    this.options.onLayoutChanged?.()
  }

  getPanes(): ManagedPane[] {
    return Array.from(this.panes.values()).map(toPublicPane)
  }

  fitAllPanes(): void {
    fitAllPanesInternal(this.panes)
  }

  getActivePane(): ManagedPane | null {
    if (this.activePaneId === null) {
      return null
    }
    const pane = this.panes.get(this.activePaneId)
    return pane ? toPublicPane(pane) : null
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
    this.applyDividerStylesWrapped()
    applyRootBackground(this.root, this.styleOptions)
  }

  /** Enable or disable programming-ligatures rendering on a single pane.
   *  Called by applyTerminalAppearance whenever the resolved ligatures state
   *  changes, so toggling the setting or switching fonts takes effect on
   *  live panes without restarting. */
  setPaneLigaturesEnabled(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    setLigaturesEnabled(pane, enabled)
  }

  setPaneGpuRendering(paneId: number, enabled: boolean): void {
    const pane = this.panes.get(paneId)
    if (!pane) {
      return
    }
    pane.gpuRenderingEnabled = enabled
    if (!enabled) {
      disposeWebgl(pane)
      return
    }
    if (pane.webglAttachmentDeferred || pane.webglDisabledAfterContextLoss) {
      return
    }
    if (!pane.webglAddon) {
      attachWebgl(pane)
      safeFit(pane)
    }
  }

  suspendRendering(): void {
    this.renderingSuspended = true
    for (const pane of this.panes.values()) {
      pane.webglAttachmentDeferred = true
      disposeWebgl(pane)
    }
  }

  resumeRendering(): void {
    this.renderingSuspended = false
    for (const pane of this.panes.values()) {
      pane.webglAttachmentDeferred = false
      if (pane.gpuRenderingEnabled && !pane.webglDisabledAfterContextLoss && !pane.webglAddon) {
        attachWebgl(pane)
        // Why: the fitPanes() optimization skips panes whose dimensions are
        // unchanged (common when a worktree goes hidden→visible at the same
        // window size). But the fresh WebGL canvas created by attachWebgl()
        // has no painted content — without an explicit refresh the terminal
        // appears frozen until something forces a dimension change (e.g. a
        // split). This mirrors the onContextLoss handler in attachWebgl which
        // calls the same refresh after falling back to the DOM renderer.
        try {
          pane.terminal.refresh(0, pane.terminal.rows - 1)
        } catch {
          /* ignore — pane may not be fully initialised yet */
        }
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
    pane.webglAttachmentDeferred = this.renderingSuspended
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
