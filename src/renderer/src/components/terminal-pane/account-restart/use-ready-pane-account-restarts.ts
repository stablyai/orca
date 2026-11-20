import { useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  onQueuedRestartPaneBound,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import type { usePaneAccountRestartStartup } from './use-pane-account-restart-startup'

export function useReadyPaneAccountRestarts({
  consumePendingPaneRestart,
  managerRef,
  paneTransportsRef,
  tabId,
  buildPaneRestartStartup,
  handleRestartPane,
  panePtyLayoutBindings
}: Pick<
  TerminalPaneCloseController,
  'consumePendingPaneRestart' | 'managerRef' | 'paneTransportsRef' | 'tabId'
> & {
  buildPaneRestartStartup: ReturnType<
    typeof usePaneAccountRestartStartup
  >['buildPaneRestartStartup']
  handleRestartPane: ReturnType<typeof usePaneProcessRestart>['handleRestartPane']
  panePtyLayoutBindings: TerminalPaneCloseController['savedLayout']['ptyIdsByLeafId']
}) {
  // Why primitive ids: another tab's queued restart stays shallow-equal and skips this pane.
  const queuedRestartPtyIds = useAppStore(
    useShallow((state) => selectReadyAccountRestartPtyIds(state, tabId))
  )
  const runQueuedAccountRestarts = useCallback(() => {
    const manager = managerRef.current
    const ready = selectReadyAccountRestartPtyIds(useAppStore.getState(), tabId)
    if (!manager || ready.length === 0) {
      return
    }
    for (const pane of manager.getPanes()) {
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !ready.includes(ptyId)) {
        continue
      }
      const restart = consumePendingPaneRestart(ptyId)
      const startup = restart ? buildPaneRestartStartup(restart, pane.leafId) : null
      if (restart && startup) {
        // Why: Claude switches and manual restarts hit many panes at once; none was the one the user clicked.
        handleRestartPane(pane.id, startup, {
          focus: restart.intent === 'account' && restart.agent === 'codex'
        })
      }
    }
  }, [
    buildPaneRestartStartup,
    consumePendingPaneRestart,
    handleRestartPane,
    managerRef,
    paneTransportsRef,
    tabId
  ])
  useEffect(() => {
    runQueuedAccountRestarts()
  }, [panePtyLayoutBindings, queuedRestartPtyIds, runQueuedAccountRestarts])
  // Why a microtask: the bind fires inside the connection handler, which must finish before a restart replaces it.
  useEffect(
    () => onQueuedRestartPaneBound(tabId, () => queueMicrotask(runQueuedAccountRestarts)),
    [runQueuedAccountRestarts, tabId]
  )
}
