import {
  isCodexAccountRestart,
  codexAccountRestartToken,
  currentCodexAccountRestart
} from '@/store/terminals/codex-account-restart-continuation'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  prepareCodexAccountRestart,
  failCodexAccountRestart
} from './codex-account-restart-execution'
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  isAccountRestartReady,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { usePaneProcessRestart } from '../process-exit/use-pane-process-restart'
import type { usePaneAccountRestartStartup } from './use-pane-account-restart-startup'

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
  // Why primitive ids: unrelated status updates stay shallow-equal and skip this pane.
  const readyRestartPtyIds = useAppStore(
    useShallow((state) => selectReadyAccountRestartPtyIds(state, tabId))
  )
  useEffect(() => {
    const manager = managerRef.current
    if (!manager || readyRestartPtyIds.length === 0) {
      return
    }
    for (const pane of manager.getPanes()) {
      const key = makePaneKey(tabId, pane.leafId)
      const queued = useAppStore.getState().paneAccountRestarts[key]
      if (isCodexAccountRestart(queued) && queued.phase === 'accepted') {
        const request = useAppStore.getState().claimCodexAccountRestart(key)
        if (!request) {
          continue
        }
        const token = codexAccountRestartToken(request)
        void prepareCodexAccountRestart(request)
          .then((condition) => {
            const latest = currentCodexAccountRestart(useAppStore.getState(), token)
            if (!condition || !latest?.startup) {
              return
            }
            if (
              managerRef.current !== manager ||
              !manager.getPanes().some((p) => p.id === pane.id && p.leafId === latest.leafId)
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
          .catch((error) => failCodexAccountRestart(token, error))
        continue
      }
      const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId()
      if (
        !ptyId ||
        !readyRestartPtyIds.includes(ptyId) ||
        !isAccountRestartReady(useAppStore.getState(), tabId, pane.leafId, ptyId)
      ) {
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
    panePtyLayoutBindings,
    readyRestartPtyIds,
    managerRef,
    paneTransportsRef,
    tabId
  ])
}
