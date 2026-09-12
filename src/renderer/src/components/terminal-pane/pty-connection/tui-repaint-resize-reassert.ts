import {
  PANE_TUI_REPAINT_REQUEST_EVENT,
  type PaneTuiRepaintRequestDetail
} from '@/lib/pane-manager/pane-tui-repaint-request'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Re-sends the settled grid when a rich-input open/close reflows a full-screen TUI. */
export function installTuiRepaintResizeReassert(session: ConnectPanePtySession): void {
  session.onTuiRepaintRequest = (event: Event): void => {
    const detail = (event as CustomEvent<PaneTuiRepaintRequestDetail>).detail
    if (
      detail &&
      detail.cols === session.pane.terminal.cols &&
      detail.rows === session.pane.terminal.rows &&
      session.pane.terminal.buffer.active.type === 'alternate'
    ) {
      // Reassert only the settled size through the normal authority/hold path;
      // transient dimensions can strand delayed SSH or runtime resize relays.
      session.forwardPtyResize(detail.cols, detail.rows)
    }
  }
  session.pane.container.addEventListener(
    PANE_TUI_REPAINT_REQUEST_EVENT,
    session.onTuiRepaintRequest
  )
}
