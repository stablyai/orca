import type { PanelLayoutNode } from '../../../shared/types'

/** Opens a detached canvas window holding one tile. Detaching a single panel
 *  or shell is just a canvas of one leaf — the popout keeps every canvas
 *  affordance (split, resize, reattach) so one tile can grow into a wall. */
function openDetachedCanvas(root: PanelLayoutNode, title: string | null): void {
  void window.api.panelCanvasPopout.open({ layout: root, layoutId: null, title })
}

export function detachPanelIntoWindow(
  kind: 'terminal' | 'web',
  panelId: string,
  title: string | null
): void {
  openDetachedCanvas({ kind, panelId }, title)
}

export function detachShellIntoWindow(host: string | null, label: string | null): void {
  openDetachedCanvas({ kind: 'shell', host, ...(label ? { label } : {}) }, label)
}
