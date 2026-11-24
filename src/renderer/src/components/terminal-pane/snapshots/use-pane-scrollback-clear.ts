import { useCallback } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { clearTerminalScrollbackAndFollowOutput } from '@/lib/pane-manager/terminal-scroll/terminal-scrollback-clear'
import { clearWebRuntimeTerminalBuffer } from '@/runtime/hosted-terminals/actions/web-runtime-terminal-buffer-actions'
import type { TerminalPaneStartupController } from '../controller/use-terminal-pane-startup-actions'
import { clearRetainedInlineScrollback } from './terminal-scrollback-ref-hydration'

export function usePaneScrollbackClear({
  initialLayoutRef,
  clearedScrollbackLeafIdsRef,
  paneTransportsRef,
  persistLayoutSnapshot
}: Pick<
  TerminalPaneStartupController,
  'initialLayoutRef' | 'clearedScrollbackLeafIdsRef' | 'paneTransportsRef'
> & {
  persistLayoutSnapshot: () => void
}) {
  const clearPaneScrollback = useCallback(
    (pane: ManagedPane): void => {
      initialLayoutRef.current = clearRetainedInlineScrollback(
        initialLayoutRef.current,
        pane.leafId
      )
      clearedScrollbackLeafIdsRef.current.add(pane.leafId)
      clearTerminalScrollbackAndFollowOutput(pane.terminal)
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
      const clearedRemoteHostBuffer = clearWebRuntimeTerminalBuffer(ptyId)
      if (!clearedRemoteHostBuffer && ptyId) {
        window.api.pty.clearBuffer(ptyId)
      }
      persistLayoutSnapshot()
    },
    [initialLayoutRef, paneTransportsRef, persistLayoutSnapshot, clearedScrollbackLeafIdsRef]
  )
  return { clearPaneScrollback }
}
