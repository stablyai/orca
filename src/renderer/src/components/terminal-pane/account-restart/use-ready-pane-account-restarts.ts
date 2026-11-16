import { useCallback, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import {
  onQueuedRestartPaneBound,
  selectReadyAccountRestartPtyIds
} from './pane-account-restart-readiness'
import {
  lookUpDiscoveredClaudeRestart,
  requeueRestart,
  restartsOnLookedUpSession,
  warnsLostClaudeRecord
} from './discovered-claude-restart'
import { takeQueuedClaudeRestart } from '@/lib/agent-session/accounts/claude/claude-queued-restart-records'
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
  const runReadyAccountRestarts = useCallback(() => {
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
      const queued = agent === 'claude' ? takeQueuedClaudeRestart(ptyId) : undefined
      if (warnsLostClaudeRecord(agent, { tabId, leafId: pane.leafId }, queued)) {
        continue
      }
      const startup =
        agent && !restartsOnLookedUpSession({ tabId, leafId: pane.leafId }, queued)
          ? buildAccountRestartStartup(
              agent,
              pane.leafId,
              undefined,
              queued?.restartAll,
              !queued?.session
            )
          : null
      if (agent && startup) {
        // Why: one Claude switch restarts many panes at once; none was the one the user clicked.
        handleRestartPane(pane.id, startup, { focus: agent === 'codex' })
      } else if (agent === 'claude') {
        const { id, leafId } = pane
        void lookUpDiscoveredClaudeRestart(agent, { ptyId, tabId, leafId }, queued, (session) =>
          buildAccountRestartStartup(agent, leafId, session, queued?.restartAll)
        ).then((found) => {
          const bound =
            useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
          if (found && paneTransportsRef.current.get(id)?.getPtyId() === ptyId) {
            handleRestartPane(id, found, { focus: false })
          } else if (found && bound) {
            requeueRestart(bound, agent, queued)
          }
        })
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
    runReadyAccountRestarts()
  }, [panePtyLayoutBindings, readyRestartPtyIds, runReadyAccountRestarts])
  // Why a microtask: the bind fires inside the connection handler; the restart runs once it yields, and the handler's later steps check their transport is still current.
  useEffect(
    () => onQueuedRestartPaneBound(tabId, () => queueMicrotask(runReadyAccountRestarts)),
    [runReadyAccountRestarts, tabId]
  )
}
