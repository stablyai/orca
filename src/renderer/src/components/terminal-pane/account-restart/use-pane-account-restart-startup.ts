import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import {
  buildManualRestartStartup,
  buildPaneAccountRestartStartup
} from '@/lib/agent-session/accounts/agent-account-restart-startup'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { PendingPaneRestart } from '@/store/terminals/terminal-contracts'

export function usePaneAccountRestartStartup({
  tabId,
  worktreeId
}: Pick<TerminalPaneCloseController, 'tabId' | 'worktreeId'>) {
  const buildPaneRestartStartup = useCallback(
    (restart: PendingPaneRestart, leafId: string) => {
      const pane = {
        tabId,
        worktreeId,
        leafId,
        shellOverride: useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.shellOverride
      }
      return restart.intent === 'manual'
        ? buildManualRestartStartup(restart.agent, pane)
        : buildPaneAccountRestartStartup(restart.agent, pane)
    },
    [tabId, worktreeId]
  )
  return { buildPaneRestartStartup }
}
