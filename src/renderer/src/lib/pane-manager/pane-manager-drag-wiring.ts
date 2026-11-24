import type { DragReorderCallbacks } from './pane-layout/pane-drag-reorder'
import type { PaneManagerHost } from './pane-manager-host'
import { applyDividerStyles, applyPaneOpacity, createDivider } from './pane-layout/pane-divider'
import { refitPanesUnder } from './pane-layout/pane-tree-ops'
import { safeFit } from './terminal-fit/pane-fit'

export function createManagedPaneDivider(host: PaneManagerHost, isVertical: boolean): HTMLElement {
  return createDivider(isVertical, host.getStyleOptions(), {
    refitPanesUnder: (el) => refitPanesUnder(el, host.panes),
    onLayoutChanged: host.options.onLayoutChanged,
    onDragActiveChange: host.options.onPaneDragActiveChange,
    onDividerRatiosCommitted: host.options.onDividerRatiosCommitted
  })
}

export function createPaneDragCallbacks(host: PaneManagerHost): DragReorderCallbacks {
  return {
    getPanes: () => host.panes,
    getRoot: () => host.root,
    getStyleOptions: () => host.getStyleOptions(),
    isDestroyed: () => host.isDestroyed(),
    safeFit,
    applyPaneOpacity: () =>
      applyPaneOpacity(host.panes.values(), host.getActivePaneId(), host.getStyleOptions()),
    applyDividerStyles: () => applyDividerStyles(host.root, host.getStyleOptions()),
    refitPanesUnder: (el: HTMLElement) => refitPanesUnder(el, host.panes),
    requestPaneReparentFrame: (callback: FrameRequestCallback) => {
      host.requestPaneReparentFrame(callback)
    },
    onLayoutChanged: host.options.onLayoutChanged,
    onDragActiveChange: host.options.onPaneDragActiveChange,
    resolveExternalDropTarget: host.options.resolveExternalPaneDropTarget,
    onExternalPaneDrop: host.options.onExternalPaneDrop,
    onDividerRatiosCommitted: host.options.onDividerRatiosCommitted,
    takePaneDrop: host.options.takePaneDrop
  }
}
