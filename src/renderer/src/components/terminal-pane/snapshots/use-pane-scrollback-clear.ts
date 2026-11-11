import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scroll/terminal-scrollback-clear'
import { clearWebRuntimeTerminalBuffer } from '@/runtime/hosted-terminals/actions/web-runtime-terminal-buffer-actions'
import type { TerminalPaneStartupController } from '../controller/use-terminal-pane-startup-actions'

export function usePaneScrollbackClear({
  clearedScrollbackLeafIdsRef,
  paneTransportsRef,
  persistLayoutSnapshot
}: Pick<TerminalPaneStartupController, 'clearedScrollbackLeafIdsRef' | 'paneTransportsRef'> & {
  persistLayoutSnapshot: () => void
}) {
  const clearPaneScrollback = useCallback(
    (pane: ManagedPane): void => {
      clearedScrollbackLeafIdsRef.current.add(pane.leafId)
      clearTerminalScrollbackAndFollowOutput(pane.terminal)
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const clearedRemoteHostBuffer = clearWebRuntimeTerminalBuffer(ptyId)
      if (!clearedRemoteHostBuffer && ptyId) {
        window.api.pty.clearBuffer(ptyId)
      }
      persistLayoutSnapshot()
    },
    [paneTransportsRef, persistLayoutSnapshot, clearedScrollbackLeafIdsRef]
  )
  return { clearPaneScrollback }
}
