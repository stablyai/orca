import { useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  onQueuedRestartPaneReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import type { usePaneAccountRestartStartup } from './use-pane-account-restart-startup'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  isCodexAccountRestart,
  codexAccountRestartToken,
  currentCodexAccountRestart
} from '@/store/terminals/codex-account-restart-continuation'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart
} from './codex-account-restart-execution'

export function useReadyPaneAccountRestarts({
  consumePendingPaneAccountRestart,
  managerRef,
  paneTransportsRef,
  tabId,
  buildAccountRestartStartup,
  handleRestartPane,
  panePtyLayoutBindings
}: Pick<
  TerminalPaneCloseController,
  'consumePendingPaneAccountRestart' | 'managerRef' | 'paneTransportsRef' | 'tabId'
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
      const key = makePaneKey(tabId, pane.leafId)
      const queued = useAppStore.getState().pendingPaneAccountRestarts[key]
      if (isCodexAccountRestart(queued) && queued.phase === 'accepted') {
        const request = useAppStore.getState().claimCodexAccountRestart(key)
        if (!request) {
          continue
        }
        const token = codexAccountRestartToken(request)
        const transport = paneTransportsRef.current.get(pane.id)
        void prepareCodexAccountRestart(request)
          .then((condition) => {
            const latest = currentCodexAccountRestart(useAppStore.getState(), token)
            if (!condition || !latest?.startup) {
              return
            }
            if (
              managerRef.current !== manager ||
              paneTransportsRef.current.get(pane.id) !== transport ||
              !manager
                .getPanes()
                .some((candidate) => candidate.id === pane.id && candidate.leafId === latest.leafId)
            ) {
              useAppStore.getState().updateCodexAccountRestart(token, { phase: 'accepted' })
              return
            }
            handleRestartPane(pane.id, latest.startup, {
              focus: true,
              accountRestart: condition,
              accountRestartToken: token
            })
          })
          .catch((error: unknown) =>
            failCodexAccountRestart(token, error, 'failed', { notDispatched: true })
          )
        continue
      }
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (!ptyId || !ready.includes(ptyId)) {
        continue
      }
      const agent = consumePendingPaneAccountRestart(ptyId)
      const startup = agent ? buildAccountRestartStartup(agent, pane.leafId) : null
      if (agent && startup) {
        // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
        handleRestartPane(pane.id, startup, { focus: agent === 'codex' })
      }
    }
  }, [
    buildAccountRestartStartup,
    consumePendingPaneAccountRestart,
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
    () => onQueuedRestartPaneReady(tabId, () => queueMicrotask(runQueuedAccountRestarts)),
    [runQueuedAccountRestarts, tabId]
  )
}
