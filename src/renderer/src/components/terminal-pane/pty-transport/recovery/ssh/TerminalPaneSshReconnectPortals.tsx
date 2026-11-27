import { Suspense } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import type { TerminalPaneController } from '../../../controller/use-terminal-pane-controller'

const TerminalSshReconnectOverlay = lazy(() =>
  import('./TerminalSshReconnectOverlay').then((module) => ({
    default: module.TerminalSshReconnectOverlay
  }))
)

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
          <Suspense fallback={null}>
            <TerminalSshReconnectOverlay
              targetId={sshReconnectTargetId}
              targetLabel={sshReconnectTargetLabel}
              status={sshReconnectStatus}
              error={sshReconnectError}
              targetRemoved={sshReconnectTargetRemoved}
              worktreeId={worktreeId}
              sshOwnerEnvironmentId={sshReconnectEnvironmentId}
            />
          </Suspense>,
          pane.container,
          `ssh-reconnect-${pane.id}`
        )
      )}
    </>
  )
}
