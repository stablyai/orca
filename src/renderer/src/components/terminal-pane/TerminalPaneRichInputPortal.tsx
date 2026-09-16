import { createPortal } from 'react-dom'
import { TerminalRichInput } from './TerminalRichInput'
import { resolveTerminalDropTargetShell } from './terminal-drop-shell'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import type { TerminalPaneController } from './use-terminal-pane-controller'

export function TerminalPaneRichInputPortal({
  controller
}: {
  controller: TerminalPaneController
}) {
  const {
    isActive,
    effectiveChatViewMode,
    activePane,
    paneTransportsRef,
    resolveAgentForLeaf,
    richInputLeafId,
    tabId,
    worktreeId,
    cwd,
    closeRichInput,
    submitRichInputForPane
  } = controller
  const activePaneTransport = activePane ? paneTransportsRef.current.get(activePane.id) : undefined
  const activePaneRichInputAgent = resolveAgentForLeaf(activePane?.leafId ?? null)
  const activePaneConnectionId = activePaneTransport?.getConnectionId?.() ?? null
  const activePaneRuntimeEnvironmentId = activePaneTransport?.getRuntimeEnvironmentId?.() ?? null
  const activePaneTargetShell = resolveTerminalDropTargetShell({
    activeRuntimeEnvironmentId: activePaneRuntimeEnvironmentId,
    worktreePath: cwd,
    connectionId: activePaneConnectionId,
    remotePlatform: getTerminalPasteSshRemotePlatform(activePaneConnectionId)
  })
  return isActive && !effectiveChatViewMode && activePane?.container
    ? createPortal(
        <TerminalRichInput
          open={richInputLeafId === activePane.leafId}
          pane={activePane}
          scopeKey={`${tabId}:${activePane.leafId}`}
          worktreeId={worktreeId}
          worktreePath={cwd ?? ''}
          agent={activePaneRichInputAgent}
          connectionId={activePaneConnectionId}
          runtimeEnvironmentId={activePaneRuntimeEnvironmentId}
          targetShell={activePaneTargetShell}
          onClose={closeRichInput}
          onSubmit={(text, imagePaths) => submitRichInputForPane(activePane, text, imagePaths)}
        />,
        activePane.container,
        `terminal-rich-input-${tabId}-${activePane.leafId}`
      )
    : null
}
