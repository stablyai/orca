import { useRef } from 'react'
import { updateTerminalRemoteRuntimeRecoveryUiState } from '../../terminal-remote-runtime-recovery-ui-state'
import type { PtyTransportRecoveryState } from '../pty-transport-types'
import type { TerminalPaneFoundation } from '../../controller/use-terminal-pane-foundation'

export function useTerminalPaneRecoveryCallback({
  setPtyRecoveryStatesByPaneId
}: Pick<TerminalPaneFoundation, 'setPtyRecoveryStatesByPaneId'>) {
  const onPtyRecoveryStateRef = useRef(
    (paneId: number, state: PtyTransportRecoveryState | null) => {
      setPtyRecoveryStatesByPaneId((previous) =>
        updateTerminalRemoteRuntimeRecoveryUiState(previous, paneId, state)
      )
    }
  )
  return { onPtyRecoveryStateRef }
}
