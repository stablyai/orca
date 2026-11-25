import { createPortal } from 'react-dom'
import { TerminalSshReconnectOverlay } from './TerminalSshReconnectOverlay'
import type { TerminalPaneController } from '../../../controller/use-terminal-pane-controller'

export function TerminalPaneSshReconnectPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const {
    managedPanes,
    showSshReconnectOverlay,
    sshReconnectEnvironmentId,
    sshReconnectError,
    sshReconnectStatus,
    sshReconnectTargetId,
    sshReconnectTargetLabel,
    sshReconnectTargetRemoved,
    worktreeId
  } = controller
  if (!showSshReconnectOverlay || !sshReconnectTargetId || !sshReconnectStatus) {
    return null
  }
  return (
    <>
      {managedPanes.map((pane) =>
        createPortal(
          <TerminalSshReconnectOverlay
            targetId={sshReconnectTargetId}
            targetLabel={sshReconnectTargetLabel}
            status={sshReconnectStatus}
            error={sshReconnectError}
            targetRemoved={sshReconnectTargetRemoved}
            worktreeId={worktreeId}
            sshOwnerEnvironmentId={sshReconnectEnvironmentId}
          />,
          pane.container,
          `ssh-reconnect-${pane.id}`
        )
      )}
    </>
  )
}
