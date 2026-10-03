import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { terminalImageAttachmentScope } from './terminal-image-attachment-scope'
import { TerminalImageAttachmentTray } from './TerminalImageAttachmentTray'
import type { TerminalPaneController } from './use-terminal-pane-controller'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'

function PaneImageAttachments({
  pane,
  controller
}: {
  pane: ManagedPane
  controller: TerminalPaneController
}) {
  const paneKey = makePaneKey(controller.tabId, pane.leafId)
  const ptyId = controller.paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
  const scope = useAppStore((state) => terminalImageAttachmentScope(state, paneKey, ptyId))
  if (
    !scope ||
    !controller.isActive ||
    controller.activePane?.id !== pane.id ||
    controller.effectiveChatViewMode
  ) {
    return null
  }
  return createPortal(
    <TerminalImageAttachmentTray key={scope} container={pane.container} />,
    pane.container,
    `image-attachments-${paneKey}`
  )
}

export function TerminalImageAttachmentPortals({
  controller
}: {
  controller: TerminalPaneController
}) {
  return controller.managedPanes.map((pane) => (
    <PaneImageAttachments key={pane.leafId} pane={pane} controller={controller} />
  ))
}
