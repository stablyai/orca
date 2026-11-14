import { useCallback } from 'react'
import { useAppStore } from '../../../store'
import { buildPaneAccountRestartStartup } from '@/lib/agent-session/accounts/agent-account-restart-startup'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

export function usePaneAccountRestartStartup({
  tabId,
  worktreeId
}: Pick<TerminalPaneCloseController, 'tabId' | 'worktreeId'>) {
  const buildAccountRestartStartup = useCallback(
    (agent: AccountRestartAgent, leafId: string) =>
      buildPaneAccountRestartStartup(agent, {
        tabId,
        worktreeId,
        leafId,
        shellOverride: useAppStore
          .getState()
          .tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.shellOverride
      }),
    [tabId, worktreeId]
  )
  return { buildAccountRestartStartup }
}
