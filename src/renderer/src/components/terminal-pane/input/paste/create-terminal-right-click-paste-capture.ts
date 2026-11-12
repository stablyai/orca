import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { pasteBelongsToPaneControl } from './paste-belongs-to-pane-control'
import {
  claimTerminalRightClickPasteMouseDown,
  isTerminalRightClickPasteGesture
} from './terminal-right-click-paste-gesture'

export function createTerminalRightClickPasteCapture({
  rightClickToPaste,
  findClickedPane
}: {
  rightClickToPaste: boolean
  findClickedPane: (target: EventTarget | null) => ManagedPane | null
}) {
  const onMouseDownCapture = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!isTerminalRightClickPasteGesture(event, rightClickToPaste)) {
      return
    }
    // SETUP-PASTE: right-click paste is the terminal's only when the click is on the terminal.
    if (pasteBelongsToPaneControl(event.target)) {
      return
    }
    const clickedPane = findClickedPane(event.target)
    if (clickedPane) {
      claimTerminalRightClickPasteMouseDown(event, clickedPane.terminal)
    }
  }
  return { onMouseDownCapture }
}
