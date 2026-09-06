export const PANE_TUI_REPAINT_REQUEST_EVENT = 'orca-pane-tui-repaint-request'

export type PaneTuiRepaintRequestDetail = {
  cols: number
  rows: number
}

export function requestPaneTuiRepaint(
  container: HTMLElement,
  detail: PaneTuiRepaintRequestDetail
): void {
  container.dispatchEvent(
    new CustomEvent<PaneTuiRepaintRequestDetail>(PANE_TUI_REPAINT_REQUEST_EVENT, { detail })
  )
}
