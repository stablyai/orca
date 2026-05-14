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
import { createPaneDOM, openTerminal, setLigaturesEnabled, disposePane } from './pane-lifecycle'
import { disposeWebgl } from './pane-webgl-renderer'
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
import { applyTerminalGpuAcceleration } from './pane-terminal-gpu-acceleration'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import {
  markPaneComplexScriptOutput,
  resumePaneRendering,
  setPaneGpuRenderingState,
  suspendPaneRendering
} from './pane-rendering-control'
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

  // Drag-to-reorder state
  private dragState = createDragReorderState()

  constructor(root: HTMLElement, options: PaneManagerOptions) {
    this.root = root
    this.options = options
    this.renderingSuspended = options.initialRenderingSuspended === true
  }

  createInitialPane(opts?: { focus?: boolean }): ManagedPane {
    const pane = this.createPaneInternal()
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

    void this.options.onPaneCreated?.(toPublicPane(pane))
    return toPublicPane(pane)
  }

  splitPane(
    paneId: number,
    direction: 'vertical' | 'horizontal',
    opts?: { ratio?: number; cwd?: string }
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

    // Why: wrapInSplit reparents the existing container, resetting scrollTop.
    const scrollState = captureScrollState(existing.terminal)
    // Why: lock prevents safeFit/fitAllPanes from restoring scroll during
    // the async settle window — scheduleSplitScrollRestore owns the restore.
    existing.pendingSplitScrollState = scrollState

    // Why: DOM reparenting can silently invalidate a WebGL context without
    // firing contextlost — Chromium reclaims the oldest context near its
    // ~8–16 limit. Dispose before the move, reattach in the 200ms timer.
    const hadWebgl = !!existing.webglAddon
    disposeWebgl(existing)

    wrapInSplit(existing.container, newPane.container, isVertical, divider, opts)

    openTerminal(newPane)
    this.activePaneId = newPane.id
    applyPaneOpacity(this.panes.values(), this.activePaneId, this.styleOptions)
    applyDividerStyles(this.root, this.styleOptions)
    newPane.terminal?.focus()
    updateMultiPaneState(this.getDragCallbacks())
    // Why: forward cwd hint so the new PTY spawns in the source pane's cwd.
    void this.options.onPaneCreated?.(
      toPublicPane(newPane),
      opts?.cwd ? { cwd: opts.cwd } : undefined
    )
    this.options.onLayoutChanged?.()

    const reattach = hadWebgl ? reattachWebglIfNeeded : undefined
    scheduleSplitScrollRestore(
      (id) => this.panes.get(id),
      existing.id,
      scrollState,
      () => this.destroyed,
      reattach
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
      const next = this.panes.values().next().value as ManagedPaneInternal | undefined
      this.activePaneId = next?.id ?? null
      next?.terminal.focus()
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
    this.root.innerHTML = ''
    this.activePaneId = null
  }

  private createPaneInternal(): ManagedPaneInternal {
    const id = this.nextPaneId++
    const pane = createPaneDOM(
      id,
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
    return pane
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
