import { useEffect } from 'react'
import { stripSshReconnectOwnedErrorLines } from '../TerminalErrorToast'
import { mapPaneTerminalErrors } from '../terminal-error-accumulation'
import type { TerminalPaneMobileController } from '../controller/use-terminal-pane-mobile-actions'

export function useSshReconnectErrorOwnership({
  setTerminalError,
  setTerminalErrorsByPaneId,
  sshReconnectOwnsTerminalErrors
}: Pick<
  TerminalPaneMobileController,
  'setTerminalError' | 'setTerminalErrorsByPaneId' | 'sshReconnectOwnsTerminalErrors'
>) {
  // SSH reconnect owns its errors even while hidden; clear only those lines after recovery.
  useEffect(() => {
    if (!sshReconnectOwnsTerminalErrors) {
      return
    }
    setTerminalError((current) =>
      current === null ? null : stripSshReconnectOwnedErrorLines(current)
    )
    setTerminalErrorsByPaneId((current) =>
      mapPaneTerminalErrors(current, stripSshReconnectOwnedErrorLines)
    )
  }, [sshReconnectOwnsTerminalErrors, setTerminalError, setTerminalErrorsByPaneId])
}
