export type PaneCanvasToolbarTrailingInset =
  | 'none'
  | 'window-controls'
  | 'window-controls-and-sidebar-toggle'

export function paneCanvasToolbarTrailingInsetClassName(
  inset: PaneCanvasToolbarTrailingInset
): string {
  if (inset === 'window-controls-and-sidebar-toggle') {
    return ' pane-canvas-toolbar-window-controls-and-toggle-inset'
  }
  return inset === 'window-controls' ? ' pane-canvas-toolbar-window-controls-inset' : ''
}
