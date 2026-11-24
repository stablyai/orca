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
import { stopCodexPaneForAccountRestart } from './codex-account-restart-stop'

export function useReadyPaneAccountRestarts({
  consumePendingPaneAccountRestart,
  managerRef,
  paneTransportsRef,
  tabId,
  worktreeId,
  buildAccountRestartStartup,
  handleRestartPane,
  panePtyLayoutBindings
}: Pick<
  TerminalPaneCloseController,
  'consumePendingPaneAccountRestart' | 'managerRef' | 'paneTransportsRef' | 'tabId' | 'worktreeId'
> & {
  buildAccountRestartStartup: ReturnType<
    typeof usePaneAccountRestartStartup
  >['buildAccountRestartStartup']
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
      const agent = consumePendingPaneAccountRestart(ptyId)
      const restartWithReplacement = (): void => {
        const startup = agent ? buildAccountRestartStartup(agent, pane.leafId) : null
        if (agent && startup) {
          // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
          handleRestartPane(pane.id, startup, { focus: agent === 'codex' })
        }
      }
      if (agent !== 'codex') {
        restartWithReplacement()
        continue
      }
      // Codex restart only stops the process; the pane's own resume brings it back on the new account.
      void stopCodexPaneForAccountRestart({ worktreeId, tabId, leafId: pane.leafId, ptyId }).then(
        (handled) => {
          if (
            handled === 'fallback' &&
            paneTransportsRef.current.get(pane.id)?.getPtyId() === ptyId
          ) {
            restartWithReplacement()
          }
        }
      )
    }
  }, [
    buildAccountRestartStartup,
    consumePendingPaneAccountRestart,
    handleRestartPane,
    managerRef,
    paneTransportsRef,
    tabId,
    worktreeId
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
